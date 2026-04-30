import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedPrescription {
  medicationName: string;
  strength: string;
  directions: string;
  copayCents: number;
}

interface SeedPatient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
  payerName: string;
  planName: string;
  memberId: string;
  prescriptions: SeedPrescription[];
}

const seedPatients: SeedPatient[] = [
  {
    firstName: "Sarah",
    lastName: "Chen",
    dateOfBirth: "1985-03-15",
    phone: "(555) 867-5309",
    payerName: "Aetna",
    planName: "PPO",
    memberId: "ANT-88912",
    prescriptions: [
      {
        medicationName: "Lisinopril",
        strength: "10mg",
        directions: "Take one tablet by mouth once daily",
        copayCents: 500
      },
      {
        medicationName: "Metformin",
        strength: "500mg",
        directions: "Take one tablet by mouth twice daily",
        copayCents: 1000
      },
      {
        medicationName: "Atorvastatin",
        strength: "20mg",
        directions: "Take one tablet by mouth once daily",
        copayCents: 1500
      }
    ]
  },
  {
    firstName: "Marcus",
    lastName: "Rivera",
    dateOfBirth: "1978-11-02",
    phone: "(555) 222-0102",
    payerName: "BlueCross",
    planName: "Choice",
    memberId: "BCR-44021",
    prescriptions: [
      {
        medicationName: "Amlodipine",
        strength: "5mg",
        directions: "Take one tablet by mouth once daily",
        copayCents: 800
      },
      {
        medicationName: "Rosuvastatin",
        strength: "10mg",
        directions: "Take one tablet by mouth once daily",
        copayCents: 1200
      }
    ]
  },
  {
    firstName: "Priya",
    lastName: "Patel",
    dateOfBirth: "1990-07-22",
    phone: "(555) 333-0198",
    payerName: "Cigna",
    planName: "Open Access",
    memberId: "CGN-73204",
    prescriptions: [
      {
        medicationName: "Levothyroxine",
        strength: "50mcg",
        directions: "Take one tablet by mouth every morning",
        copayCents: 700
      },
      {
        medicationName: "Albuterol",
        strength: "90mcg",
        directions: "Inhale two puffs every four to six hours as needed",
        copayCents: 2000
      }
    ]
  }
];

async function main() {
  await prisma.appSetting.upsert({
    where: { key: "setup_status" },
    update: { value: "complete" },
    create: {
      key: "setup_status",
      value: "complete"
    }
  });

  await resetDemoWorkflowState();

  await prisma.pharmacy.upsert({
    where: {
      name_addressLine1: {
        name: "CVS Pharmacy",
        addressLine1: "1234 Main St"
      }
    },
    update: {},
    create: {
      name: "CVS Pharmacy",
      addressLine1: "1234 Main St"
    }
  });

  for (const seedPatient of seedPatients) {
    await seedPatientProfile(seedPatient);
  }
}

async function resetDemoWorkflowState() {
  await prisma.conversationMessage.deleteMany();
  await prisma.conversationSession.deleteMany();
  await prisma.refillRequest.deleteMany();
}

async function seedPatientProfile(seedPatient: SeedPatient) {
  const patient = await prisma.patient.upsert({
    where: { phone: seedPatient.phone },
    update: {
      firstName: seedPatient.firstName,
      lastName: seedPatient.lastName,
      dateOfBirth: new Date(`${seedPatient.dateOfBirth}T00:00:00.000Z`)
    },
    create: {
      firstName: seedPatient.firstName,
      lastName: seedPatient.lastName,
      dateOfBirth: new Date(`${seedPatient.dateOfBirth}T00:00:00.000Z`),
      phone: seedPatient.phone
    }
  });

  const insurancePolicy = await prisma.insurancePolicy.upsert({
    where: { memberId: seedPatient.memberId },
    update: {
      patientId: patient.id,
      payerName: seedPatient.payerName,
      planName: seedPatient.planName,
      active: true
    },
    create: {
      patientId: patient.id,
      payerName: seedPatient.payerName,
      planName: seedPatient.planName,
      memberId: seedPatient.memberId,
      active: true
    }
  });

  for (const seedPrescription of seedPatient.prescriptions) {
    const prescription = await prisma.prescription.upsert({
      where: {
        patientId_medicationName_strength: {
          patientId: patient.id,
          medicationName: seedPrescription.medicationName,
          strength: seedPrescription.strength
        }
      },
      update: {
        directions: seedPrescription.directions,
        status: "ACTIVE"
      },
      create: {
        patientId: patient.id,
        medicationName: seedPrescription.medicationName,
        strength: seedPrescription.strength,
        directions: seedPrescription.directions,
        status: "ACTIVE"
      }
    });

    await prisma.copayRule.upsert({
      where: {
        insurancePolicyId_prescriptionId: {
          insurancePolicyId: insurancePolicy.id,
          prescriptionId: prescription.id
        }
      },
      update: { amountCents: seedPrescription.copayCents },
      create: {
        insurancePolicyId: insurancePolicy.id,
        prescriptionId: prescription.id,
        amountCents: seedPrescription.copayCents
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

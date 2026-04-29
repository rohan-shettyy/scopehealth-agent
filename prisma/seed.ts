import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.appSetting.upsert({
    where: { key: "setup_status" },
    update: { value: "complete" },
    create: {
      key: "setup_status",
      value: "complete"
    }
  });

  const patient = await prisma.patient.upsert({
    where: { phone: "(555) 867-5309" },
    update: {
      firstName: "Sarah",
      lastName: "Chen",
      dateOfBirth: new Date("1985-03-15T00:00:00.000Z")
    },
    create: {
      firstName: "Sarah",
      lastName: "Chen",
      dateOfBirth: new Date("1985-03-15T00:00:00.000Z"),
      phone: "(555) 867-5309"
    }
  });

  const pharmacy = await prisma.pharmacy.upsert({
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

  const insurancePolicy = await prisma.insurancePolicy.upsert({
    where: { memberId: "ANT-88912" },
    update: {
      patientId: patient.id,
      payerName: "Aetna",
      planName: "PPO",
      active: true
    },
    create: {
      patientId: patient.id,
      payerName: "Aetna",
      planName: "PPO",
      memberId: "ANT-88912",
      active: true
    }
  });

  const prescriptions = await Promise.all([
    prisma.prescription.upsert({
      where: {
        patientId_medicationName_strength: {
          patientId: patient.id,
          medicationName: "Lisinopril",
          strength: "10mg"
        }
      },
      update: {
        directions: "Take one tablet by mouth once daily",
        status: "ACTIVE"
      },
      create: {
        patientId: patient.id,
        medicationName: "Lisinopril",
        strength: "10mg",
        directions: "Take one tablet by mouth once daily",
        status: "ACTIVE"
      }
    }),
    prisma.prescription.upsert({
      where: {
        patientId_medicationName_strength: {
          patientId: patient.id,
          medicationName: "Metformin",
          strength: "500mg"
        }
      },
      update: {
        directions: "Take one tablet by mouth twice daily",
        status: "ACTIVE"
      },
      create: {
        patientId: patient.id,
        medicationName: "Metformin",
        strength: "500mg",
        directions: "Take one tablet by mouth twice daily",
        status: "ACTIVE"
      }
    }),
    prisma.prescription.upsert({
      where: {
        patientId_medicationName_strength: {
          patientId: patient.id,
          medicationName: "Atorvastatin",
          strength: "20mg"
        }
      },
      update: {
        directions: "Take one tablet by mouth once daily",
        status: "ACTIVE"
      },
      create: {
        patientId: patient.id,
        medicationName: "Atorvastatin",
        strength: "20mg",
        directions: "Take one tablet by mouth once daily",
        status: "ACTIVE"
      }
    })
  ]);

  const copaysByMedication = new Map([
    ["Lisinopril", 500],
    ["Metformin", 1000],
    ["Atorvastatin", 1500]
  ]);

  for (const prescription of prescriptions) {
    const amountCents = copaysByMedication.get(prescription.medicationName);

    if (amountCents === undefined) {
      continue;
    }

    await prisma.copayRule.upsert({
      where: {
        insurancePolicyId_prescriptionId: {
          insurancePolicyId: insurancePolicy.id,
          prescriptionId: prescription.id
        }
      },
      update: { amountCents },
      create: {
        insurancePolicyId: insurancePolicy.id,
        prescriptionId: prescription.id,
        amountCents
      }
    });
  }

  await prisma.refillRequest.upsert({
    where: { id: 1 },
    update: {
      patientId: patient.id,
      prescriptionId: null,
      pharmacyId: pharmacy.id,
      insurancePolicyId: insurancePolicy.id,
      status: "DRAFT",
      identityVerified: false,
      verifiedAt: null,
      insuranceVerified: false,
      copayAmountCents: null,
      lastCompletedStep: null,
      nextExpectedStep: "verify_identity"
    },
    create: {
      id: 1,
      patientId: patient.id,
      pharmacyId: pharmacy.id,
      insurancePolicyId: insurancePolicy.id,
      status: "DRAFT",
      nextExpectedStep: "verify_identity"
    }
  });
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

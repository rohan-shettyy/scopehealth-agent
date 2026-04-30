import { prisma } from "@/lib/prisma";
import type {
  ConversationChannel as DbConversationChannel,
  ConversationMessage,
  ConversationSession,
  ConversationSessionStatus as DbConversationSessionStatus,
  MessageRole as DbMessageRole,
  Patient,
  Pharmacy,
  Prescription,
  Prisma,
  RefillRequest
} from "@prisma/client";

import {
  type CopaySummary,
  type ConversationChannel,
  type InsuranceSummary,
  type MedicationChoice,
  type PatientSummary,
  type PharmacyChoice,
  type RefillWorkflowContext,
  type RefillSessionState,
  type SessionStatus,
  type WorkflowStep,
  createInitialSessionState,
  isWorkflowStep
} from "@/domain/workflow";

export const DEMO_PATIENT_PHONE = "(555) 867-5309";

export type ConversationMessageRole = "system" | "assistant" | "user" | "tool";

interface CreateConversationSessionInput {
  patientId?: number;
  channel?: ConversationChannel;
  sessionKey?: string;
}

interface AppendConversationMessageInput {
  sessionId: number;
  role: ConversationMessageRole;
  content: string;
}

export interface SessionTranscript {
  session: ConversationSessionSnapshot;
  messages: ConversationTranscriptMessage[];
  refillRequest?: RefillRequestSnapshot;
}

export interface ConversationTranscriptMessage {
  id: number;
  role: ConversationMessageRole;
  content: string;
  sequence: number;
  createdAt: string;
}

export interface ConversationSessionSnapshot {
  id: number;
  sessionKey: string;
  patientId?: number;
  patient?: PatientSummary;
  refillRequestId?: number;
  state: RefillSessionState;
  createdAt: string;
  updatedAt: string;
}

export interface RefillRequestSnapshot {
  id: number;
  patientId: number;
  prescriptionId?: number;
  prescriptionIds?: number[];
  pharmacyId?: number;
  alternatePharmacy?: string;
  insurancePolicyId?: number;
  status: string;
  identityVerified: boolean;
  verifiedAt?: string;
  insuranceVerified: boolean;
  copayAmountCents?: number;
  lastCompletedStep?: string;
  nextExpectedStep?: string;
  createdAt: string;
  updatedAt: string;
}

export class DuplicateRefillRequestError extends Error {
  constructor(public readonly medicationNames: string[]) {
    super(
      medicationNames.length === 1
        ? `A refill request already exists for ${medicationNames[0]}. I cannot create a duplicate request.`
        : `A refill request already exists for ${medicationNames.join(", ")}. I cannot create a duplicate request.`
    );
    this.name = "DuplicateRefillRequestError";
  }
}

type SessionWithSelections = ConversationSession & {
  patient: Patient | null;
  selectedMedication: Prescription | null;
  selectedPharmacy: Pharmacy | null;
};

type PatientWithWorkflowData = Patient & {
  prescriptions: Prescription[];
  insurancePolicies: Array<{
    id: number;
    payerName: string;
    planName: string;
    memberId: string;
    copayRules: Array<{
      prescriptionId: number;
      insurancePolicyId: number;
      amountCents: number;
    }>;
  }>;
};

export async function loadDemoPatientWorkflowContext(): Promise<RefillWorkflowContext> {
  return loadPatientWorkflowContextByPhone(DEMO_PATIENT_PHONE);
}

export async function loadAllPatientIdentitySummaries(): Promise<PatientSummary[]> {
  const patients = await prisma.patient.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }]
  });

  return patients.map(toPatientSummary);
}

export async function loadCallTranscriptionVocabulary(): Promise<string[]> {
  const [patients, prescriptions, insurancePolicies, pharmacies] = await Promise.all([
    prisma.patient.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }]
    }),
    prisma.prescription.findMany({
      where: { status: "ACTIVE" },
      orderBy: { medicationName: "asc" }
    }),
    prisma.insurancePolicy.findMany({
      where: { active: true },
      orderBy: [{ payerName: "asc" }, { planName: "asc" }]
    }),
    prisma.pharmacy.findMany({
      orderBy: [{ name: "asc" }, { addressLine1: "asc" }]
    })
  ]);

  return [
    ...patients.flatMap((patient) => [
      patient.firstName,
      patient.lastName,
      `${patient.firstName} ${patient.lastName}`,
      `${patient.firstName} ${patient.lastName}, spelled ${spellForSpeech(patient.firstName)} ${spellForSpeech(patient.lastName)}`,
      `${patient.firstName} ${patient.lastName}, pronounced ${spaceSyllables(patient.firstName)} ${spaceSyllables(patient.lastName)}`
    ]),
    ...prescriptions.flatMap((prescription) => [
      prescription.medicationName,
      `${prescription.medicationName} ${prescription.strength}`,
      `${prescription.medicationName}, spelled ${spellForSpeech(prescription.medicationName)}`,
      `${prescription.medicationName}, pronounced ${spaceSyllables(prescription.medicationName)}`
    ]),
    ...insurancePolicies.flatMap((policy) => [
      policy.payerName,
      policy.planName,
      `${policy.payerName} ${policy.planName}`,
      `${policy.payerName}, spelled ${spellForSpeech(policy.payerName)}`,
      `${policy.planName}, spelled ${spellForSpeech(policy.planName)}`
    ]),
    ...pharmacies.flatMap((pharmacy) => [
      pharmacy.name,
      pharmacy.addressLine1,
      `${pharmacy.name} ${pharmacy.addressLine1}`,
      `${pharmacy.name}, spelled ${spellForSpeech(pharmacy.name)}`
    ])
  ].filter((value, index, values) => values.indexOf(value) === index);
}

export async function loadCallTranscriptCorrectionTerms(): Promise<string[]> {
  const [patients, prescriptions, insurancePolicies, pharmacies] = await Promise.all([
    prisma.patient.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }]
    }),
    prisma.prescription.findMany({
      where: { status: "ACTIVE" },
      orderBy: { medicationName: "asc" }
    }),
    prisma.insurancePolicy.findMany({
      where: { active: true },
      orderBy: [{ payerName: "asc" }, { planName: "asc" }]
    }),
    prisma.pharmacy.findMany({
      orderBy: [{ name: "asc" }, { addressLine1: "asc" }]
    })
  ]);

  return [
    ...patients.flatMap((patient) => [
      patient.firstName,
      patient.lastName,
      `${patient.firstName} ${patient.lastName}`
    ]),
    ...prescriptions.map((prescription) => prescription.medicationName),
    ...insurancePolicies.flatMap((policy) => [
      policy.payerName,
      policy.planName,
      `${policy.payerName} ${policy.planName}`
    ]),
    ...pharmacies.flatMap((pharmacy) => [
      pharmacy.name,
      pharmacy.addressLine1,
      `${pharmacy.name} ${pharmacy.addressLine1}`
    ])
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function spellForSpeech(value: string): string {
  return value
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .split("")
    .join(" ");
}

function spaceSyllables(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z]+/g, " ")
    .replace(/([aeiouy])([bcdfghjklmnpqrstvwxyz]{2,})/gi, "$1 $2")
    .replace(/([bcdfghjklmnpqrstvwxyz])([aeiouy])/gi, "$1 $2")
    .trim();
}

export async function loadPatientWorkflowContextById(
  patientId: number
): Promise<RefillWorkflowContext> {
  const [patient, pharmacyOnFile] = await Promise.all([
    prisma.patient.findUnique({
      where: { id: patientId },
      include: {
        prescriptions: {
          where: { status: "ACTIVE" },
          orderBy: { medicationName: "asc" }
        },
        insurancePolicies: {
          where: { active: true },
          include: {
            copayRules: true
          },
          take: 1
        }
      }
    }),
    prisma.pharmacy.findFirst({
      orderBy: { id: "asc" }
    })
  ]);

  if (!patient) {
    throw new Error(`No patient found for id ${patientId}`);
  }

  if (!pharmacyOnFile) {
    throw new Error("No pharmacy on file found for demo workflow");
  }

  return buildWorkflowContext(patient, pharmacyOnFile);
}

export async function loadPatientWorkflowContextByPhone(
  phone: string
): Promise<RefillWorkflowContext> {
  const [patient, pharmacyOnFile] = await Promise.all([
    prisma.patient.findUnique({
      where: { phone },
      include: {
        prescriptions: {
          where: { status: "ACTIVE" },
          orderBy: { medicationName: "asc" }
        },
        insurancePolicies: {
          where: { active: true },
          include: {
            copayRules: true
          },
          take: 1
        }
      }
    }),
    prisma.pharmacy.findFirst({
      orderBy: { id: "asc" }
    })
  ]);

  if (!patient) {
    throw new Error(`No patient found for phone ${phone}`);
  }

  if (!pharmacyOnFile) {
    throw new Error("No pharmacy on file found for demo workflow");
  }

  return buildWorkflowContext(patient, pharmacyOnFile);
}

export async function loadSeededPatientByPhone(
  phone = DEMO_PATIENT_PHONE
): Promise<PatientSummary> {
  const patient = await prisma.patient.findUnique({
    where: { phone }
  });

  if (!patient) {
    throw new Error(`No seeded patient found for phone ${phone}`);
  }

  return toPatientSummary(patient);
}


export async function createConversationSession(
  input: CreateConversationSessionInput = {}
): Promise<ConversationSessionSnapshot> {
  const channel = input.channel ?? "call";
  const initialState = createInitialSessionState(channel);
  const session = await prisma.conversationSession.create({
    data: {
      sessionKey: input.sessionKey ?? createSessionKey(channel),
      patientId: input.patientId,
      channel: toDbChannel(channel),
      status: toDbSessionStatus(initialState.status),
      identityVerified: initialState.identityVerified,
      insuranceVerified: initialState.insuranceVerified,
      nextExpectedStep: initialState.nextExpectedStep
    },
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function appendConversationMessage(
  input: AppendConversationMessageInput
): Promise<ConversationTranscriptMessage> {
  const message = await prisma.$transaction(async (tx) => {
    const lastMessage = await tx.conversationMessage.findFirst({
      where: { conversationSessionId: input.sessionId },
      orderBy: { sequence: "desc" }
    });

    return tx.conversationMessage.create({
      data: {
        conversationSessionId: input.sessionId,
        role: toDbMessageRole(input.role),
        content: input.content,
        sequence: (lastMessage?.sequence ?? 0) + 1
      }
    });
  });

  return toTranscriptMessage(message);
}

export async function updateConversationSessionState(
  sessionId: number,
  updatedState: Partial<RefillSessionState>
): Promise<ConversationSessionSnapshot> {
  const session = await prisma.conversationSession.update({
    where: { id: sessionId },
    data: toSessionUpdateData(updatedState),
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function attachPatientToConversationSession(
  sessionId: number,
  patientId: number,
  updatedState: Partial<RefillSessionState>
): Promise<ConversationSessionSnapshot> {
  const session = await prisma.conversationSession.update({
    where: { id: sessionId },
    data: {
      patient: { connect: { id: patientId } },
      ...toSessionUpdateData(updatedState)
    },
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function endCallSession(
  sessionId: number
): Promise<ConversationSessionSnapshot> {
  const existing = await prisma.conversationSession.findUniqueOrThrow({
    where: { id: sessionId }
  });

  if (existing.channel !== "CALL") {
    throw new Error("Only call sessions can be ended with endCallSession");
  }

  const session = await prisma.conversationSession.update({
    where: { id: sessionId },
    data: { status: "ENDED" },
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function switchSessionToSms(
  sessionId: number
): Promise<ConversationSessionSnapshot> {
  const session = await prisma.conversationSession.update({
    where: { id: sessionId },
    data: {
      channel: "SMS",
      status: "ACTIVE"
    },
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function createRefillRequestFromSession(
  sessionId: number
): Promise<RefillRequestSnapshot> {
  const refillRequest = await prisma.$transaction(async (tx) => {
    const session = await tx.conversationSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        refillRequest: true
      }
    });

    if (session.refillRequest) {
      return session.refillRequest;
    }

    assertSessionCanCreateRefill(session);
    await assertNoDuplicateRefillRequests(tx, session);

    const created = await tx.refillRequest.create({
      data: {
        patientId: session.patientId,
        prescriptionId: session.selectedMedicationId,
        prescriptionIdsJson: session.selectedMedicationsJson
          ? JSON.stringify(parseMedicationChoices(session.selectedMedicationsJson).map(
              (medication) => medication.prescriptionId
            ))
          : session.selectedMedicationId
            ? JSON.stringify([session.selectedMedicationId])
            : undefined,
        pharmacyId: session.selectedPharmacyId,
        alternatePharmacy: session.alternatePharmacy,
        insurancePolicyId: await findActiveInsurancePolicyId(
          tx,
          session.patientId
        ),
        status: "SUBMITTED",
        identityVerified: session.identityVerified,
        verifiedAt: session.verifiedAt,
        insuranceVerified: session.insuranceVerified,
        copayAmountCents: session.copayAmountCents,
        lastCompletedStep: session.lastCompletedStep,
        nextExpectedStep: session.nextExpectedStep
      }
    });

    await tx.conversationSession.update({
      where: { id: sessionId },
      data: {
        refillRequestId: created.id,
        status: session.channel === "CALL" ? "ACTIVE" : "COMPLETED"
      }
    });

    return created;
  });

  return toRefillRequestSnapshot(refillRequest);
}

export async function findDuplicateRefillMedicationNamesForSession(
  sessionId: number
): Promise<string[]> {
  const session = await prisma.conversationSession.findUniqueOrThrow({
    where: { id: sessionId }
  });

  if (!session.patientId || session.refillRequestId) {
    return [];
  }

  return findDuplicateMedicationNames(prisma, {
    ...session,
    patientId: session.patientId
  });
}

export async function resetSessionAfterDuplicateMedication(
  sessionId: number
): Promise<ConversationSessionSnapshot> {
  const session = await prisma.conversationSession.update({
    where: { id: sessionId },
    data: {
      selectedMedication: { disconnect: true },
      selectedMedicationsJson: null,
      selectedPharmacy: { disconnect: true },
      alternatePharmacy: null,
      insuranceVerified: false,
      copayAmountCents: null,
      lastCompletedStep: "identify_patient",
      nextExpectedStep: "select_medication",
      status: "ACTIVE"
    },
    include: sessionSelections
  });

  return toSessionSnapshot(session);
}

export async function fetchSessionTranscript(
  sessionId: number
): Promise<SessionTranscript> {
  const session = await prisma.conversationSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      ...sessionSelections,
      messages: {
        orderBy: { sequence: "asc" }
      },
      refillRequest: true
    }
  });

  return {
    session: toSessionSnapshot(session),
    messages: session.messages.map(toTranscriptMessage),
    refillRequest: session.refillRequest
      ? toRefillRequestSnapshot(session.refillRequest)
      : undefined
  };
}

function buildWorkflowContext(
  patient: PatientWithWorkflowData,
  pharmacyOnFile: Pharmacy
): RefillWorkflowContext {
  const insurancePolicy = patient.insurancePolicies[0];

  if (!insurancePolicy) {
    throw new Error(`No active insurance policy found for patient ${patient.id}`);
  }

  return {
    patient: toPatientSummary(patient),
    activePrescriptions: patient.prescriptions.map(toMedicationChoice),
    pharmacyOnFile: {
      pharmacyId: pharmacyOnFile.id,
      name: pharmacyOnFile.name,
      addressLine1: pharmacyOnFile.addressLine1
    },
    insurancePolicy: {
      insurancePolicyId: insurancePolicy.id,
      payerName: insurancePolicy.payerName,
      planName: insurancePolicy.planName,
      memberId: insurancePolicy.memberId
    },
    copayRules: insurancePolicy.copayRules.map((copayRule): CopaySummary => ({
      prescriptionId: copayRule.prescriptionId,
      insurancePolicyId: copayRule.insurancePolicyId,
      amountCents: copayRule.amountCents
    }))
  };
}

function toSessionSnapshot(
  session: SessionWithSelections
): ConversationSessionSnapshot {
  const lastCompletedStep = toWorkflowStep(session.lastCompletedStep);
  const nextExpectedStep =
    toWorkflowStep(session.nextExpectedStep) ?? "identify_patient";

  return {
    id: session.id,
    sessionKey: session.sessionKey,
    patientId: session.patientId ?? undefined,
    patient: session.patient ? toPatientSummary(session.patient) : undefined,
    refillRequestId: session.refillRequestId ?? undefined,
    state: {
      channel: fromDbChannel(session.channel),
      status: fromDbSessionStatus(session.status),
      identityVerified: session.identityVerified,
      verifiedAt: session.verifiedAt?.toISOString(),
      selectedMedication: session.selectedMedication
        ? toMedicationChoice(session.selectedMedication)
        : undefined,
      selectedMedications: parseSessionSelectedMedications(session),
      selectedPharmacy: toSelectedPharmacyChoice(session),
      insuranceVerified: session.insuranceVerified,
      copayAmountCents: session.copayAmountCents ?? undefined,
      lastCompletedStep,
      nextExpectedStep
    },
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

function toSessionUpdateData(
  state: Partial<RefillSessionState>
): Prisma.ConversationSessionUpdateInput {
  return {
    channel: state.channel ? toDbChannel(state.channel) : undefined,
    status: state.status ? toDbSessionStatus(state.status) : undefined,
    identityVerified: state.identityVerified,
    verifiedAt: state.verifiedAt ? new Date(state.verifiedAt) : undefined,
    selectedMedication: state.selectedMedication
      ? { connect: { id: state.selectedMedication.prescriptionId } }
      : undefined,
    selectedMedicationsJson: state.selectedMedications
      ? JSON.stringify(state.selectedMedications)
      : undefined,
    selectedPharmacy: toSelectedPharmacyUpdate(state.selectedPharmacy),
    alternatePharmacy: toAlternatePharmacyUpdate(state.selectedPharmacy),
    insuranceVerified: state.insuranceVerified,
    copayAmountCents: state.copayAmountCents,
    lastCompletedStep: state.lastCompletedStep,
    nextExpectedStep: state.nextExpectedStep
  };
}

function toSelectedPharmacyUpdate(
  selectedPharmacy: PharmacyChoice | undefined
): Prisma.PharmacyUpdateOneWithoutSelectedInSessionsNestedInput | undefined {
  if (!selectedPharmacy) {
    return undefined;
  }

  if (selectedPharmacy.pharmacyId) {
    return { connect: { id: selectedPharmacy.pharmacyId } };
  }

  return { disconnect: true };
}

function toAlternatePharmacyUpdate(
  selectedPharmacy: PharmacyChoice | undefined
): string | null | undefined {
  if (!selectedPharmacy) {
    return undefined;
  }

  return selectedPharmacy.pharmacyId ? null : selectedPharmacy.name;
}

function toPatientSummary(patient: Patient): PatientSummary {
  return {
    id: patient.id,
    fullName: `${patient.firstName} ${patient.lastName}`,
    dateOfBirth: patient.dateOfBirth.toISOString().slice(0, 10),
    phone: patient.phone
  };
}

function toMedicationChoice(prescription: Prescription): MedicationChoice {
  return {
    prescriptionId: prescription.id,
    medicationName: prescription.medicationName,
    strength: prescription.strength,
    directions: prescription.directions
  };
}

function toSelectedPharmacyChoice(
  session: SessionWithSelections
): PharmacyChoice | undefined {
  if (session.selectedPharmacy) {
    return {
      pharmacyId: session.selectedPharmacy.id,
      name: session.selectedPharmacy.name,
      addressLine1: session.selectedPharmacy.addressLine1
    };
  }

  if (session.alternatePharmacy) {
    return {
      name: session.alternatePharmacy,
      isAlternate: true
    };
  }

  return undefined;
}

function toTranscriptMessage(
  message: ConversationMessage
): ConversationTranscriptMessage {
  return {
    id: message.id,
    role: fromDbMessageRole(message.role),
    content: message.content,
    sequence: message.sequence,
    createdAt: message.createdAt.toISOString()
  };
}

function toRefillRequestSnapshot(
  refillRequest: RefillRequest
): RefillRequestSnapshot {
  return {
    id: refillRequest.id,
    patientId: refillRequest.patientId,
    prescriptionId: refillRequest.prescriptionId ?? undefined,
    prescriptionIds: parsePrescriptionIds(refillRequest.prescriptionIdsJson),
    pharmacyId: refillRequest.pharmacyId ?? undefined,
    alternatePharmacy: refillRequest.alternatePharmacy ?? undefined,
    insurancePolicyId: refillRequest.insurancePolicyId ?? undefined,
    status: refillRequest.status,
    identityVerified: refillRequest.identityVerified,
    verifiedAt: refillRequest.verifiedAt?.toISOString(),
    insuranceVerified: refillRequest.insuranceVerified,
    copayAmountCents: refillRequest.copayAmountCents ?? undefined,
    lastCompletedStep: refillRequest.lastCompletedStep ?? undefined,
    nextExpectedStep: refillRequest.nextExpectedStep ?? undefined,
    createdAt: refillRequest.createdAt.toISOString(),
    updatedAt: refillRequest.updatedAt.toISOString()
  };
}

function assertSessionCanCreateRefill(
  session: ConversationSession
): asserts session is ConversationSession & {
  patientId: number;
  selectedMedicationId: number | null;
  copayAmountCents: number;
} {
  const selectedMedicationCount =
    parseMedicationChoices(session.selectedMedicationsJson).length +
    (session.selectedMedicationId ? 1 : 0);

  if (
    !session.patientId ||
    !session.identityVerified ||
    selectedMedicationCount === 0 ||
    (!session.selectedPharmacyId && !session.alternatePharmacy) ||
    !session.insuranceVerified ||
    session.copayAmountCents === null
  ) {
    throw new Error("Session is missing required fields for refill creation");
  }
}

async function findActiveInsurancePolicyId(
  tx: Prisma.TransactionClient,
  patientId: number
): Promise<number> {
  const policy = await tx.insurancePolicy.findFirst({
    where: {
      patientId,
      active: true
    },
    orderBy: { id: "asc" }
  });

  if (!policy) {
    throw new Error(`No active insurance policy found for patient ${patientId}`);
  }

  return policy.id;
}

async function assertNoDuplicateRefillRequests(
  tx: Prisma.TransactionClient,
  session: ConversationSession & { patientId: number }
) {
  const medicationNames = await findDuplicateMedicationNames(tx, session);

  if (medicationNames.length > 0) {
    throw new DuplicateRefillRequestError(medicationNames);
  }
}

async function findDuplicateMedicationNames(
  tx: Prisma.TransactionClient,
  session: ConversationSession & { patientId: number }
): Promise<string[]> {
  const requestedIds = getSessionPrescriptionIds(session);

  if (requestedIds.length === 0) {
    return [];
  }

  const existingRequests = await tx.refillRequest.findMany({
    where: {
      patientId: session.patientId,
      id: session.refillRequestId ? { not: session.refillRequestId } : undefined,
      status: { in: ["IN_PROGRESS", "SUBMITTED", "COMPLETED"] }
    }
  });

  const duplicateIds = new Set<number>();

  for (const request of existingRequests) {
    const existingIds = [
      ...(request.prescriptionId ? [request.prescriptionId] : []),
      ...(parsePrescriptionIds(request.prescriptionIdsJson) ?? [])
    ];

    for (const id of existingIds) {
      if (requestedIds.includes(id)) {
        duplicateIds.add(id);
      }
    }
  }

  if (duplicateIds.size === 0) {
    return [];
  }

  const prescriptions = await tx.prescription.findMany({
    where: { id: { in: [...duplicateIds] } },
    orderBy: { medicationName: "asc" }
  });

  return prescriptions.map((prescription) => prescription.medicationName);
}

function getSessionPrescriptionIds(session: ConversationSession): number[] {
  const selectedIds = parseMedicationChoices(session.selectedMedicationsJson).map(
    (medication) => medication.prescriptionId
  );

  return [
    ...(session.selectedMedicationId ? [session.selectedMedicationId] : []),
    ...selectedIds
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function createSessionKey(channel: ConversationChannel): string {
  return `${channel}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toWorkflowStep(value: string | null): WorkflowStep | undefined {
  return value && isWorkflowStep(value) ? value : undefined;
}

function toDbChannel(channel: ConversationChannel): DbConversationChannel {
  return channel === "call" ? "CALL" : "SMS";
}

function fromDbChannel(channel: DbConversationChannel): ConversationChannel {
  return channel === "CALL" ? "call" : "sms";
}

function toDbSessionStatus(
  status: SessionStatus
): DbConversationSessionStatus {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "ended":
      return "ENDED";
    case "completed":
      return "COMPLETED";
  }
}

function fromDbSessionStatus(
  status: DbConversationSessionStatus
): SessionStatus {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "ENDED":
      return "ended";
    case "COMPLETED":
      return "completed";
  }
}

function toDbMessageRole(role: ConversationMessageRole): DbMessageRole {
  switch (role) {
    case "system":
      return "SYSTEM";
    case "assistant":
      return "ASSISTANT";
    case "user":
      return "USER";
    case "tool":
      return "TOOL";
  }
}

function fromDbMessageRole(role: DbMessageRole): ConversationMessageRole {
  switch (role) {
    case "SYSTEM":
      return "system";
    case "ASSISTANT":
      return "assistant";
    case "USER":
      return "user";
    case "TOOL":
      return "tool";
  }
}

const sessionSelections = {
  patient: true,
  selectedMedication: true,
  selectedPharmacy: true
} satisfies Prisma.ConversationSessionInclude;

function parseSessionSelectedMedications(
  session: SessionWithSelections
): MedicationChoice[] | undefined {
  const medications = parseMedicationChoices(session.selectedMedicationsJson);

  if (medications.length > 0) {
    return medications;
  }

  return session.selectedMedication
    ? [toMedicationChoice(session.selectedMedication)]
    : undefined;
}

function parseMedicationChoices(value: string | null | undefined): MedicationChoice[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as MedicationChoice[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePrescriptionIds(value: string | null | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as number[];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === "number")
      : undefined;
  } catch {
    return undefined;
  }
}

import {
  WORKFLOW_STEPS,
  type MedicationChoice,
  type PatientSummary,
  type PharmacyChoice,
  type RefillWorkflowContext,
  type RefillWorkflowResult,
  type RefillSessionState,
  type WorkflowStep,
  hasRequiredRefillFields
} from "@/domain/workflow";
import { getGeminiLiveConfig } from "@/lib/voice/config";
import { generateTextWithGemini } from "@/lib/voice/gemini-text-client";

type GeminiChannel = "call" | "sms";

interface GeminiWorkflowJson {
  agentReply?: string;
  identityVerified?: boolean;
  selectedMedicationName?: string;
  selectedMedicationNames?: string[];
  selectedPharmacyName?: string;
  selectedPharmacyAddress?: string;
  usePharmacyOnFile?: boolean;
  insuranceVerified?: boolean;
  communicateCopay?: boolean;
  completeRefill?: boolean;
  nextExpectedStep?: string;
}

interface GeminiIdentityJson {
  agentReply?: string;
  patientFullName?: string;
  dateOfBirth?: string;
}

export interface PatientIdentityResult {
  patient?: PatientSummary;
  agentReply: string;
}

export async function identifyPatientForRefillWorkflow(
  input: { text: string },
  patients: PatientSummary[],
  channel: GeminiChannel
): Promise<PatientIdentityResult> {
  const raw = await generateTextWithGemini(
    buildPatientIdentitySystem(channel),
    buildPatientIdentityPrompt(input.text, patients),
    {
      model: channel === "sms" ? getGeminiLiveConfig().textModel : undefined,
      temperature: channel === "sms" ? 0.25 : 0.15,
      maxOutputTokens: 350
    }
  );

  if (!raw) {
    throw new Error("Gemini patient identity extraction did not return a response");
  }

  const parsed = parseGeminiJson(raw) as GeminiIdentityJson | undefined;
  const patient = findIdentifiedPatient(parsed, patients);

  if (!patient) {
    return {
      agentReply:
        parsed?.agentReply ??
        "I need your full name and date of birth before I can help with a refill. Please say both together."
    };
  }

  return {
    patient,
    agentReply:
      parsed?.agentReply ??
      `Thanks, ${patient.fullName}. I found your profile. Which medication would you like to refill?`
  };
}

export async function advanceGeminiRefillWorkflow(
  state: RefillSessionState,
  input: { text: string; receivedAt?: string },
  context: RefillWorkflowContext,
  channel: GeminiChannel
): Promise<RefillWorkflowResult> {
  const raw = await generateTextWithGemini(
    buildGeminiWorkflowSystem(channel),
    buildGeminiWorkflowPrompt(state, input.text, context, channel),
    {
      model: channel === "sms" ? getGeminiLiveConfig().textModel : undefined,
      temperature: channel === "sms" ? 0.35 : 0.2,
      maxOutputTokens: 700
    }
  );

  if (!raw) {
    throw new Error("Gemini workflow orchestration did not return a response");
  }

  const parsed = parseGeminiJson(raw);

  if (!parsed?.agentReply) {
    throw new Error("Gemini workflow orchestration returned unusable structured output");
  }

  const selectedMedications = resolveMedications(parsed, state, context, input.text);
  const selectedMedication = selectedMedications[0];
  const selectedPharmacy = resolvePharmacy(parsed, state, context);
  const identityVerified = state.identityVerified || parsed.identityVerified === true;
  const insuranceVerified =
    state.insuranceVerified || parsed.insuranceVerified === true;
  const copayAmountCents =
    (parsed.communicateCopay || insuranceVerified) && selectedMedications.length > 0
      ? resolveTotalCopay(selectedMedications, context)
      : state.copayAmountCents;
  const proposedState = {
    ...state,
    identityVerified,
    selectedMedication,
    selectedMedications,
    selectedPharmacy,
    insuranceVerified,
    copayAmountCents
  };
  const nextExpectedStep = deriveNextStep(proposedState);
  const completeRefill =
    parsed.completeRefill === true &&
    state.nextExpectedStep === "complete_refill" &&
    hasRequiredRefillFields({
      identityVerified,
      verifiedAt: identityVerified
        ? state.verifiedAt ?? input.receivedAt ?? new Date().toISOString()
        : undefined,
      selectedMedication,
      selectedMedications,
      selectedPharmacy,
      insuranceVerified,
      copayAmountCents
    });
  const agentReply = buildStepAlignedAgentReply(
    nextExpectedStep,
    {
      identityVerified,
      selectedMedication,
      selectedMedications,
      selectedPharmacy,
      insuranceVerified,
      copayAmountCents
    },
    context,
    completeRefill
  );

  const updatedSession: Partial<RefillSessionState> = {
    identityVerified,
    verifiedAt:
      identityVerified && !state.verifiedAt
        ? input.receivedAt ?? new Date().toISOString()
        : undefined,
    selectedMedication:
      selectedMedication?.prescriptionId !== state.selectedMedication?.prescriptionId
        ? selectedMedication
        : undefined,
    selectedMedications:
      medicationIds(selectedMedications).join(",") !==
      medicationIds(state.selectedMedications ?? (state.selectedMedication ? [state.selectedMedication] : [])).join(",")
        ? selectedMedications
        : undefined,
    selectedPharmacy:
      selectedPharmacy && selectedPharmacy.name !== state.selectedPharmacy?.name
        ? selectedPharmacy
        : undefined,
    insuranceVerified,
    copayAmountCents,
    lastCompletedStep: getLastCompletedStep({
      identityVerified,
      selectedMedication,
      selectedMedications,
      selectedPharmacy,
      insuranceVerified,
      copayAmountCents,
      completeRefill
    }),
    nextExpectedStep,
    status: completeRefill ? (channel === "sms" ? "completed" : "active") : undefined
  };

  return {
    updatedSession,
    agentReply,
    isComplete: completeRefill,
    shouldCreateRefillRequest: completeRefill
  };
}

function buildGeminiWorkflowSystem(channel: GeminiChannel) {
  const channelInstruction =
    channel === "call"
      ? "You are controlling the call-mode refill assistant. Gemini is primary for the conversation; app code only persists your structured result."
      : "You are controlling the SMS refill assistant using gemini-3.1-flash-lite-preview. Keep replies short and text-message friendly.";

  return [
    channelInstruction,
    "Return only valid JSON. No markdown.",
    "You may discuss only patient identification, medication selection, pharmacy confirmation, insurance confirmation, copay communication, and refill completion.",
    "Do not provide medical advice, policy advice, or off-scope information.",
    "Never ask for information already present in currentState.",
    "Do not skip required fields. A refill can complete only after identity, at least one medication, pharmacy, insurance, and copay are known.",
    "If the patient is evasive, off-topic, asks unrelated questions, or refuses to answer, politely restate only the current required step.",
    "If the patient asks for multiple active prescriptions, include all of them in selectedMedicationNames.",
    "Only select medication names explicitly present in patientText. Do not infer, guess, or choose a medication just because it is active.",
    "The backend derives nextExpectedStep from persisted fields. Your nextExpectedStep must match the next missing required field.",
    "JSON shape: {\"agentReply\":\"string\",\"identityVerified\":boolean,\"selectedMedicationName\":\"string\",\"selectedMedicationNames\":[\"string\"],\"selectedPharmacyName\":\"string\",\"selectedPharmacyAddress\":\"string\",\"usePharmacyOnFile\":boolean,\"insuranceVerified\":boolean,\"communicateCopay\":boolean,\"completeRefill\":boolean,\"nextExpectedStep\":\"identify_patient|select_medication|confirm_pharmacy|verify_insurance|notify_copay|complete_refill\"}."
  ].join("\n");
}

function buildPatientIdentitySystem(channel: GeminiChannel) {
  const channelInstruction =
    channel === "call"
      ? "You are handling the first call turn for a prescription refill voice agent."
      : "You are handling the first SMS turn for a prescription refill assistant.";

  return [
    channelInstruction,
    "Return only valid JSON. No markdown.",
    "Extract the patient's full name and date of birth from the patient text.",
    "Date of birth must be normalized as YYYY-MM-DD when possible.",
    "Only identify a patient when both full name and DOB match one of the provided seeded patients.",
    "If either name or DOB is missing or does not match, ask for full name and date of birth again.",
    "Do not discuss medications, pharmacy, insurance, copay, or refill completion before identity is matched.",
    "JSON shape: {\"agentReply\":\"string\",\"patientFullName\":\"string\",\"dateOfBirth\":\"YYYY-MM-DD\"}."
  ].join("\n");
}

function buildPatientIdentityPrompt(patientText: string, patients: PatientSummary[]) {
  return JSON.stringify(
    {
      patientText,
      seededPatients: patients.map((patient) => ({
        id: patient.id,
        fullName: patient.fullName,
        dateOfBirth: patient.dateOfBirth
      })),
      requiredNextAction:
        "If matched, briefly acknowledge and ask which active medication they want to refill. If not matched, ask for full name and date of birth."
    },
    null,
    2
  );
}

function buildGeminiWorkflowPrompt(
  state: RefillSessionState,
  patientText: string,
  context: RefillWorkflowContext,
  channel: GeminiChannel
) {
  return JSON.stringify(
    {
      channel,
      patientText,
      currentState: state,
      patient: context.patient,
      activePrescriptions: context.activePrescriptions,
      pharmacyOnFile: context.pharmacyOnFile,
      insurancePolicy: context.insurancePolicy,
      copayRules: context.copayRules,
      requiredCurrentStep: deriveNextStep(state),
      requiredStepOrder: WORKFLOW_STEPS
    },
    null,
    2
  );
}

function parseGeminiJson(raw: string): GeminiWorkflowJson | undefined {
  const trimmed = raw.trim();
  const jsonText =
    trimmed.match(/```json\s*([\s\S]*?)```/)?.[1] ??
    trimmed.match(/```\s*([\s\S]*?)```/)?.[1] ??
    trimmed;

  try {
    return JSON.parse(jsonText) as GeminiWorkflowJson;
  } catch {
    const objectMatch = jsonText.match(/\{[\s\S]*\}/);

    if (!objectMatch) {
      return undefined;
    }

    try {
      return JSON.parse(objectMatch[0]) as GeminiWorkflowJson;
    } catch {
      return undefined;
    }
  }
}

function resolveMedications(
  parsed: GeminiWorkflowJson,
  state: RefillSessionState,
  context: RefillWorkflowContext,
  patientText: string
): MedicationChoice[] {
  const explicitlyMentioned = findMedicationsInText(
    patientText,
    context.activePrescriptions
  );

  if (explicitlyMentioned.length > 0) {
    return dedupeMedications(explicitlyMentioned);
  }

  const names =
    parsed.selectedMedicationNames && parsed.selectedMedicationNames.length > 0
      ? parsed.selectedMedicationNames
      : parsed.selectedMedicationName
        ? [parsed.selectedMedicationName]
        : [];

  const matched = names.flatMap((name) =>
    findMedicationsInText(name, context.activePrescriptions)
  );
  const matchedExplicitlyInText = matched.filter((medication) =>
    containsMedicationName(patientText, medication)
  );

  if (matchedExplicitlyInText.length > 0) {
    return dedupeMedications(matchedExplicitlyInText);
  }

  return state.selectedMedications ?? (state.selectedMedication ? [state.selectedMedication] : []);
}

function findMedication(
  medicationName: string,
  options: MedicationChoice[]
): MedicationChoice | undefined {
  const normalized = normalize(medicationName);

  return options.find((option) => {
    const label = normalize(`${option.medicationName} ${option.strength}`);
    return label.includes(normalized) || normalized.includes(normalize(option.medicationName));
  });
}

function findMedicationsInText(
  medicationText: string,
  options: MedicationChoice[]
): MedicationChoice[] {
  const direct = findMedication(medicationText, options);
  const normalized = normalize(medicationText);
  const mentioned = options.filter((option) =>
    normalized.includes(normalize(option.medicationName))
  );

  return mentioned.length > 0 ? mentioned : direct ? [direct] : [];
}

function containsMedicationName(text: string, medication: MedicationChoice): boolean {
  return normalize(text).includes(normalize(medication.medicationName));
}

function dedupeMedications(medications: MedicationChoice[]) {
  const byId = new Map<number, MedicationChoice>();

  for (const medication of medications) {
    byId.set(medication.prescriptionId, medication);
  }

  return [...byId.values()];
}

function medicationIds(medications: MedicationChoice[]) {
  return medications.map((medication) => medication.prescriptionId).sort((a, b) => a - b);
}

function resolvePharmacy(
  parsed: GeminiWorkflowJson,
  state: RefillSessionState,
  context: RefillWorkflowContext
): PharmacyChoice | undefined {
  if (parsed.usePharmacyOnFile) {
    return context.pharmacyOnFile;
  }

  if (parsed.selectedPharmacyName) {
    return {
      name: parsed.selectedPharmacyName,
      addressLine1: parsed.selectedPharmacyAddress,
      isAlternate: true
    };
  }

  return state.selectedPharmacy;
}

function resolveTotalCopay(
  medications: MedicationChoice[],
  context: RefillWorkflowContext
) {
  let total = 0;

  for (const medication of medications) {
    const amount = context.copayRules.find(
      (rule) =>
        rule.prescriptionId === medication.prescriptionId &&
        rule.insurancePolicyId === context.insurancePolicy.insurancePolicyId
    )?.amountCents;

    if (amount === undefined) {
      return undefined;
    }

    total += amount;
  }

  return total;
}

function deriveNextStep(
  state: Pick<
    RefillSessionState,
    | "identityVerified"
    | "selectedMedication"
    | "selectedMedications"
    | "selectedPharmacy"
    | "insuranceVerified"
    | "copayAmountCents"
  >
): WorkflowStep {
  if (!state.identityVerified) {
    return "identify_patient";
  }
  if (!hasSelectedMedicationState(state)) {
    return "select_medication";
  }
  if (!state.selectedPharmacy) {
    return "confirm_pharmacy";
  }
  if (!state.insuranceVerified) {
    return "verify_insurance";
  }
  if (state.copayAmountCents === undefined) {
    return "notify_copay";
  }
  return "complete_refill";
}

function getLastCompletedStep(input: {
  identityVerified: boolean;
  selectedMedication?: MedicationChoice;
  selectedMedications?: MedicationChoice[];
  selectedPharmacy?: PharmacyChoice;
  insuranceVerified: boolean;
  copayAmountCents?: number;
  completeRefill: boolean;
}): WorkflowStep | undefined {
  if (input.completeRefill) {
    return "complete_refill";
  }
  if (input.copayAmountCents !== undefined) {
    return "notify_copay";
  }
  if (input.insuranceVerified) {
    return "verify_insurance";
  }
  if (input.selectedPharmacy) {
    return "confirm_pharmacy";
  }
  if ((input.selectedMedications?.length ?? 0) > 0 || input.selectedMedication) {
    return "select_medication";
  }
  if (input.identityVerified) {
    return "identify_patient";
  }
  return undefined;
}

function buildStepAlignedAgentReply(
  step: WorkflowStep,
  state: Pick<
    RefillSessionState,
    | "identityVerified"
    | "selectedMedication"
    | "selectedMedications"
    | "selectedPharmacy"
    | "insuranceVerified"
    | "copayAmountCents"
  >,
  context: RefillWorkflowContext,
  completeRefill: boolean
) {
  const medicationSummary = getMedicationSummary(
    state.selectedMedications ?? (state.selectedMedication ? [state.selectedMedication] : [])
  );

  if (completeRefill) {
    return `Your refill request for ${medicationSummary} has been submitted. You are all set.`;
  }

  switch (step) {
    case "identify_patient":
      return "Please say your full name and date of birth so I can find your patient profile.";
    case "select_medication":
      return `Which medication would you like to refill? Your active prescriptions are ${context.activePrescriptions
        .map((prescription) => `${prescription.medicationName} ${prescription.strength}`)
        .join(", ")}.`;
    case "confirm_pharmacy":
      return `I have ${medicationSummary} selected. Should I use ${context.pharmacyOnFile.name} at ${context.pharmacyOnFile.addressLine1}, or a different pharmacy?`;
    case "verify_insurance":
      return `I have the pharmacy set to ${formatPharmacy(state.selectedPharmacy)}. Is your insurance still ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName}?`;
    case "notify_copay":
      return `Your copay for ${medicationSummary} is ${formatCurrency(state.copayAmountCents ?? 0)}. Say yes to submit the refill request.`;
    case "complete_refill":
      return `Your copay for ${medicationSummary} is ${formatCurrency(state.copayAmountCents ?? 0)}. Say yes to submit the refill request.`;
  }
}

function getMedicationSummary(medications: MedicationChoice[]) {
  return medications.length > 0
    ? medications
        .map((medication) => `${medication.medicationName} ${medication.strength}`)
        .join(" and ")
    : "your refill";
}

function formatPharmacy(pharmacy: PharmacyChoice | undefined) {
  if (!pharmacy) {
    return "the selected pharmacy";
  }

  return pharmacy.addressLine1 ? `${pharmacy.name} at ${pharmacy.addressLine1}` : pharmacy.name;
}

function formatCurrency(amountCents: number) {
  return `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findIdentifiedPatient(
  parsed: GeminiIdentityJson | undefined,
  patients: PatientSummary[]
): PatientSummary | undefined {
  if (!parsed?.patientFullName || !parsed.dateOfBirth) {
    return undefined;
  }

  const parsedName = normalize(parsed.patientFullName);
  const parsedDob = parsed.dateOfBirth.trim();

  return patients.find(
    (patient) =>
      normalize(patient.fullName) === parsedName &&
      patient.dateOfBirth === parsedDob
  );
}

function hasSelectedMedicationState(
  state: Pick<RefillSessionState, "selectedMedication" | "selectedMedications">
) {
  return (state.selectedMedications?.length ?? 0) > 0 || state.selectedMedication;
}

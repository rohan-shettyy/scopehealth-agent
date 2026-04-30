import {
  WORKFLOW_STEPS,
  type MedicationChoice,
  type PharmacyChoice,
  type RefillWorkflowContext,
  type RefillWorkflowResult,
  type RefillSessionState,
  type WorkflowStep,
  hasRequiredRefillFields,
  isWorkflowStep
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

  const selectedMedications = resolveMedications(parsed, state, context);
  const selectedMedication = selectedMedications[0];
  const selectedPharmacy = resolvePharmacy(parsed, state, context);
  const copayAmountCents =
    parsed.communicateCopay && selectedMedications.length > 0
      ? resolveTotalCopay(selectedMedications, context)
      : state.copayAmountCents;
  const identityVerified = state.identityVerified || parsed.identityVerified === true;
  const insuranceVerified =
    state.insuranceVerified || parsed.insuranceVerified === true;
  const nextExpectedStep = sanitizeNextStep(
    parsed.nextExpectedStep,
    {
      ...state,
      identityVerified,
      selectedMedication,
      selectedMedications,
      selectedPharmacy,
      insuranceVerified,
      copayAmountCents
    }
  );
  const completeRefill =
    parsed.completeRefill === true &&
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
    status: completeRefill ? "completed" : undefined
  };

  return {
    updatedSession,
    agentReply: parsed.agentReply,
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
    "You may discuss only DOB verification, medication selection, pharmacy confirmation, insurance confirmation, copay communication, and refill completion.",
    "Do not provide medical advice, policy advice, or off-scope information.",
    "Never ask for information already present in currentState.",
    "Do not skip required fields. A refill can complete only after identity, at least one medication, pharmacy, insurance, and copay are known.",
    "If the patient asks for multiple active prescriptions, include all of them in selectedMedicationNames.",
    "JSON shape: {\"agentReply\":\"string\",\"identityVerified\":boolean,\"selectedMedicationName\":\"string\",\"selectedMedicationNames\":[\"string\"],\"selectedPharmacyName\":\"string\",\"selectedPharmacyAddress\":\"string\",\"usePharmacyOnFile\":boolean,\"insuranceVerified\":boolean,\"communicateCopay\":boolean,\"completeRefill\":boolean,\"nextExpectedStep\":\"verify_dob|select_medication|confirm_pharmacy|verify_insurance|notify_copay|complete_refill\"}."
  ].join("\n");
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
  context: RefillWorkflowContext
): MedicationChoice[] {
  const names =
    parsed.selectedMedicationNames && parsed.selectedMedicationNames.length > 0
      ? parsed.selectedMedicationNames
      : parsed.selectedMedicationName
        ? [parsed.selectedMedicationName]
        : [];

  const matched = names.flatMap((name) =>
    findMedicationsInText(name, context.activePrescriptions)
  );

  if (matched.length > 0) {
    return dedupeMedications(matched);
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

function sanitizeNextStep(
  nextExpectedStep: string | undefined,
  state: RefillSessionState
): WorkflowStep {
  if (nextExpectedStep && isWorkflowStep(nextExpectedStep)) {
    return nextExpectedStep;
  }

  if (!state.identityVerified) {
    return "verify_dob";
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
    return "verify_dob";
  }
  return undefined;
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasSelectedMedicationState(state: RefillSessionState) {
  return (state.selectedMedications?.length ?? 0) > 0 || state.selectedMedication;
}

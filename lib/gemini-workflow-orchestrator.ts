import {
  advanceRefillWorkflow,
  type RefillWorkflowContext,
  type RefillWorkflowResult
} from "@/domain/refill-engine";
import {
  WORKFLOW_STEPS,
  type MedicationChoice,
  type PharmacyChoice,
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
  selectedPharmacyName?: string;
  selectedPharmacyAddress?: string;
  usePharmacyOnFile?: boolean;
  insuranceVerified?: boolean;
  communicateCopay?: boolean;
  completeRefill?: boolean;
  nextExpectedStep?: string;
}

export async function advanceRefillWorkflowWithGemini(
  state: RefillSessionState,
  input: { text: string; receivedAt?: string },
  context: RefillWorkflowContext,
  channel: GeminiChannel
): Promise<RefillWorkflowResult & { usedGemini: boolean }> {
  const fallback = () => ({
    ...advanceRefillWorkflow(state, input, context),
    usedGemini: false
  });

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
    return fallback();
  }

  const parsed = parseGeminiJson(raw);

  if (!parsed?.agentReply) {
    return fallback();
  }

  const selectedMedication = parsed.selectedMedicationName
    ? findMedication(parsed.selectedMedicationName, context.activePrescriptions)
    : state.selectedMedication;
  const selectedPharmacy = resolvePharmacy(parsed, state, context);
  const copayAmountCents =
    parsed.communicateCopay && selectedMedication
      ? resolveCopay(selectedMedication, context)
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
    selectedPharmacy:
      selectedPharmacy && selectedPharmacy.name !== state.selectedPharmacy?.name
        ? selectedPharmacy
        : undefined,
    insuranceVerified,
    copayAmountCents,
    lastCompletedStep: getLastCompletedStep({
      identityVerified,
      selectedMedication,
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
    shouldCreateRefillRequest: completeRefill,
    usedGemini: true
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
    "Do not skip required fields. A refill can complete only after identity, medication, pharmacy, insurance, and copay are known.",
    "JSON shape: {\"agentReply\":\"string\",\"identityVerified\":boolean,\"selectedMedicationName\":\"string\",\"selectedPharmacyName\":\"string\",\"selectedPharmacyAddress\":\"string\",\"usePharmacyOnFile\":boolean,\"insuranceVerified\":boolean,\"communicateCopay\":boolean,\"completeRefill\":boolean,\"nextExpectedStep\":\"verify_dob|select_medication|confirm_pharmacy|verify_insurance|notify_copay|complete_refill\"}."
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

function resolveCopay(
  medication: MedicationChoice,
  context: RefillWorkflowContext
) {
  return context.copayRules.find(
    (rule) =>
      rule.prescriptionId === medication.prescriptionId &&
      rule.insurancePolicyId === context.insurancePolicy.insurancePolicyId
  )?.amountCents;
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
  if (!state.selectedMedication) {
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
  if (input.selectedMedication) {
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

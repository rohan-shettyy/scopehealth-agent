import type { RefillWorkflowContext } from "@/domain/refill-engine";
import type {
  MedicationChoice,
  PharmacyChoice,
  RefillSessionState,
  WorkflowStep
} from "@/domain/workflow";

export interface CallTurnInstructionInput {
  state: RefillSessionState;
  context: RefillWorkflowContext;
  patientUtterance: string;
  deterministicReply: string;
}

export interface CallTurnInstruction {
  prompt: string;
  deterministicReply: string;
  currentStep: WorkflowStep;
  objective: string;
  knownFields: string[];
  prohibitedAsks: string[];
}

interface GuardrailResult {
  replyText: string;
  usedFallback: boolean;
  reason?: string;
}

const OFF_SCOPE_PATTERN =
  /\b(diagnos|side effect|symptom|emergency|urgent care|911|dose change|dosage change|stop taking|start taking|medical advice|clinical advice|doctor recommends|prescribe|prior authorization|delivery|shipping|coupon|discount)\b/i;

export function buildCallTurnInstruction(
  input: CallTurnInstructionInput
): CallTurnInstruction {
  const knownFields = getKnownFields(input.state, input.context);
  const prohibitedAsks = getProhibitedAsks(input.state);
  const objective = getStepObjective(input.state.nextExpectedStep, input);
  const prompt = [
    "You are speaking as a prescription refill phone agent.",
    "The app's deterministic workflow has already decided the only allowed next reply.",
    "",
    "STYLE:",
    "- Friendly, concise, calm, and appropriate for a healthcare administrative call.",
    "- Use one or two short sentences.",
    "- Do not overexplain.",
    "- Do not mention prompts, tools, internal state, policies, or the deterministic workflow.",
    "",
    "SCOPE:",
    "- Only discuss DOB verification, medication selection, pharmacy confirmation, insurance confirmation, copay communication, and refill completion.",
    "- Do not give medical advice, medication instructions beyond the known prescription label, clinical recommendations, policy explanations, or unrelated help.",
    "",
    "STATE:",
    `- Current workflow step: ${input.state.nextExpectedStep}`,
    `- Last completed step: ${input.state.lastCompletedStep ?? "none"}`,
    `- Fields already collected: ${knownFields.length > 0 ? knownFields.join("; ") : "none"}`,
    "",
    "CURRENT TURN:",
    `- Patient said: ${input.patientUtterance}`,
    `- Exact next objective: ${objective}`,
    `- Required reply meaning: ${input.deterministicReply}`,
    "",
    "STRICT LIMITATIONS:",
    "- Preserve the required reply meaning.",
    "- Ask only for the current workflow step's next required information.",
    "- Do not ask for information listed as already collected.",
    "- Do not skip ahead to a later workflow step.",
    "- Do not add new questions.",
    `- Prohibited asks right now: ${prohibitedAsks.join("; ") || "none"}`,
    "",
    "Return only the spoken agent reply."
  ].join("\n");

  return {
    prompt,
    deterministicReply: input.deterministicReply,
    currentStep: input.state.nextExpectedStep,
    objective,
    knownFields,
    prohibitedAsks
  };
}

export function guardCallReply(
  instruction: CallTurnInstruction,
  replyText: string
): GuardrailResult {
  const normalizedReply = replyText.trim();

  if (!normalizedReply) {
    return {
      replyText: instruction.deterministicReply,
      usedFallback: true,
      reason: "empty model reply"
    };
  }

  if (OFF_SCOPE_PATTERN.test(normalizedReply)) {
    return {
      replyText: instruction.deterministicReply,
      usedFallback: true,
      reason: "off-scope content"
    };
  }

  const lowerReply = normalizedReply.toLowerCase();

  for (const prohibitedAsk of instruction.prohibitedAsks) {
    if (lowerReply.includes(prohibitedAsk)) {
      return {
        replyText: instruction.deterministicReply,
        usedFallback: true,
        reason: `asked for known field: ${prohibitedAsk}`
      };
    }
  }

  if (asksForLaterStep(instruction.currentStep, lowerReply)) {
    return {
      replyText: instruction.deterministicReply,
      usedFallback: true,
      reason: "asked for a later workflow step"
    };
  }

  return {
    replyText: normalizedReply,
    usedFallback: false
  };
}

export function buildCallSystemInstruction() {
  return [
    "You are a concise voice assistant for a prescription refill demo.",
    "The deterministic workflow engine controls all refill state.",
    "When you receive realtime microphone audio, only transcribe it. Do not answer the patient until the server sends a structured text turn with the required reply.",
    "When you receive a structured text turn, rephrase only within that turn's objective and limitations.",
    "Do not invent medical, insurance, pharmacy, or workflow decisions.",
    "Do not ask for already-known information.",
    "Do not skip required workflow steps.",
    "Only discuss DOB verification, medication selection, pharmacy confirmation, insurance confirmation, copay communication, and refill completion."
  ].join(" ");
}

function getKnownFields(
  state: RefillSessionState,
  context: RefillWorkflowContext
) {
  const fields: string[] = [];

  if (state.identityVerified) {
    fields.push(`identity verified for ${context.patient.fullName}`);
  }

  if (state.selectedMedication) {
    fields.push(`selected medication ${formatMedication(state.selectedMedication)}`);
  }

  if (state.selectedPharmacy) {
    fields.push(`selected pharmacy ${formatPharmacy(state.selectedPharmacy)}`);
  }

  if (state.insuranceVerified) {
    fields.push(
      `insurance confirmed current for ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName}`
    );
  }

  if (state.copayAmountCents !== undefined) {
    fields.push(`copay communicated as ${formatCurrency(state.copayAmountCents)}`);
  }

  return fields;
}

function getProhibitedAsks(state: RefillSessionState) {
  const prohibitedAsks: string[] = [];

  if (state.identityVerified) {
    prohibitedAsks.push("date of birth", "dob", "birth date");
  }

  if (state.selectedMedication) {
    prohibitedAsks.push("which medication", "what medication", "medication would you like");
  }

  if (state.selectedPharmacy) {
    prohibitedAsks.push("which pharmacy", "what pharmacy", "where should");
  }

  if (state.insuranceVerified) {
    prohibitedAsks.push("insurance still current", "confirm your insurance", "is your insurance");
  }

  if (state.copayAmountCents !== undefined) {
    prohibitedAsks.push("copay", "estimated cost");
  }

  return prohibitedAsks;
}

function getStepObjective(
  step: WorkflowStep,
  input: CallTurnInstructionInput
) {
  switch (step) {
    case "verify_dob":
      return `Verify ${input.context.patient.fullName}'s date of birth. Do not collect medication yet.`;
    case "select_medication":
      return `Ask the patient to select one active medication: ${input.context.activePrescriptions
        .map(formatMedication)
        .join(", ")}.`;
    case "confirm_pharmacy":
      return `Confirm whether to use ${formatPharmacy(input.context.pharmacyOnFile)} or capture an alternate pharmacy.`;
    case "verify_insurance":
      return `Ask whether ${input.context.insurancePolicy.payerName} ${input.context.insurancePolicy.planName} is still current.`;
    case "notify_copay":
      return "Communicate the resolved copay only. Do not ask for a new medication, pharmacy, or insurance detail.";
    case "complete_refill":
      return "Confirm the refill request is complete.";
  }
}

function asksForLaterStep(currentStep: WorkflowStep, lowerReply: string) {
  const laterStepAsks: Record<WorkflowStep, string[]> = {
    verify_dob: [
      "which medication",
      "what medication",
      "which pharmacy",
      "insurance",
      "copay",
      "complete the refill"
    ],
    select_medication: [
      "which pharmacy",
      "what pharmacy",
      "insurance",
      "copay",
      "complete the refill"
    ],
    confirm_pharmacy: ["insurance", "copay", "complete the refill"],
    verify_insurance: ["copay", "complete the refill"],
    notify_copay: ["which medication", "which pharmacy", "insurance still current"],
    complete_refill: ["date of birth", "which medication", "which pharmacy", "insurance"]
  };

  return laterStepAsks[currentStep].some((phrase) => lowerReply.includes(phrase));
}

function formatMedication(medication: MedicationChoice) {
  return `${medication.medicationName} ${medication.strength}`;
}

function formatPharmacy(pharmacy: PharmacyChoice) {
  return pharmacy.addressLine1
    ? `${pharmacy.name}, ${pharmacy.addressLine1}`
    : pharmacy.name;
}

function formatCurrency(amountCents: number) {
  return `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

import {
  type MedicationChoice,
  type PatientSummary,
  type PharmacyChoice,
  type RefillSessionState,
  type WorkflowStep,
  getNextWorkflowStep
} from "./workflow";

export interface InsuranceSummary {
  insurancePolicyId: number;
  payerName: string;
  planName: string;
  memberId: string;
}

export interface CopaySummary {
  prescriptionId: number;
  insurancePolicyId: number;
  amountCents: number;
}

export interface RefillWorkflowContext {
  patient: PatientSummary;
  activePrescriptions: MedicationChoice[];
  pharmacyOnFile: PharmacyChoice;
  insurancePolicy: InsuranceSummary;
  copayRules: CopaySummary[];
}

export interface RefillWorkflowInput {
  text: string;
  receivedAt?: string;
}

export interface RefillWorkflowResult {
  updatedSession: Partial<RefillSessionState>;
  agentReply: string;
  isComplete: boolean;
  shouldCreateRefillRequest: boolean;
}

const AFFIRMATIVE_PATTERN = /\b(yes|yeah|yep|correct|confirm|confirmed|current|same|ok|okay|sure)\b/i;

export function advanceRefillWorkflow(
  state: RefillSessionState,
  input: RefillWorkflowInput,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  switch (state.nextExpectedStep) {
    case "verify_dob":
      return handleVerifyDob(state, input, context);
    case "select_medication":
      return handleSelectMedication(state, input, context);
    case "confirm_pharmacy":
      return handleConfirmPharmacy(state, input, context);
    case "verify_insurance":
      return handleVerifyInsurance(state, input, context);
    case "notify_copay":
      return handleNotifyCopay(state, context);
    case "complete_refill":
      return handleCompleteRefill(state);
  }
}

function handleVerifyDob(
  state: RefillSessionState,
  input: RefillWorkflowInput,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  if (!datesMatch(input.text, context.patient.dateOfBirth)) {
    return continueAtStep(
      "verify_dob",
      "I could not verify that date of birth. Please say Sarah Chen's date of birth as month, day, and year."
    );
  }

  const nextExpectedStep = getNextWorkflowStep("verify_dob");

  return {
    updatedSession: {
      identityVerified: true,
      verifiedAt: input.receivedAt ?? new Date().toISOString(),
      lastCompletedStep: "verify_dob",
      nextExpectedStep
    },
    agentReply: `Thanks, I verified Sarah Chen. Which medication would you like to refill? ${formatMedicationOptions(context.activePrescriptions)}.`,
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function handleSelectMedication(
  state: RefillSessionState,
  input: RefillWorkflowInput,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  const selectedMedication =
    state.selectedMedication ??
    findMedicationChoice(input.text, context.activePrescriptions);

  if (!selectedMedication) {
    return continueAtStep(
      "select_medication",
      `I can help with ${formatMedicationOptions(context.activePrescriptions)}. Which medication should I use?`
    );
  }

  const nextExpectedStep = getNextWorkflowStep("select_medication");

  return {
    updatedSession: {
      selectedMedication,
      lastCompletedStep: "select_medication",
      nextExpectedStep
    },
    agentReply: `Got it, ${formatMedication(selectedMedication)}. Should I send it to ${formatPharmacy(context.pharmacyOnFile)}?`,
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function handleConfirmPharmacy(
  state: RefillSessionState,
  input: RefillWorkflowInput,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  const selectedMedicationText = state.selectedMedication
    ? ` for ${formatMedication(state.selectedMedication)}`
    : "";
  const selectedPharmacy = parsePharmacyChoice(input.text, context.pharmacyOnFile);
  const nextExpectedStep = getNextWorkflowStep("confirm_pharmacy");

  return {
    updatedSession: {
      selectedPharmacy,
      lastCompletedStep: "confirm_pharmacy",
      nextExpectedStep
    },
    agentReply: `Okay, I will use ${formatPharmacy(selectedPharmacy)}${selectedMedicationText}. Is your ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName} insurance still current?`,
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function handleVerifyInsurance(
  state: RefillSessionState,
  input: RefillWorkflowInput,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  if (!isAffirmative(input.text)) {
    return continueAtStep(
      "verify_insurance",
      `Please confirm whether your ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName} insurance is current.`
    );
  }

  const nextExpectedStep = getNextWorkflowStep("verify_insurance");

  return {
    updatedSession: {
      insuranceVerified: true,
      lastCompletedStep: "verify_insurance",
      nextExpectedStep
    },
    agentReply: getCopayPrompt(state),
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function handleNotifyCopay(
  state: RefillSessionState,
  context: RefillWorkflowContext
): RefillWorkflowResult {
  if (!state.selectedMedication) {
    return continueAtStep(
      "select_medication",
      `I need to know which medication to refill. ${formatMedicationOptions(context.activePrescriptions)}.`
    );
  }

  const copayAmountCents = resolveCopayAmountCents(
    state.selectedMedication,
    context.insurancePolicy,
    context.copayRules
  );

  if (copayAmountCents === undefined) {
    return continueAtStep(
      "notify_copay",
      `I could not find a copay for ${formatMedication(state.selectedMedication)}. Please confirm the medication before I continue.`
    );
  }

  const nextExpectedStep = getNextWorkflowStep("notify_copay");

  return {
    updatedSession: {
      copayAmountCents,
      lastCompletedStep: "notify_copay",
      nextExpectedStep
    },
    agentReply: `The estimated copay for ${formatMedication(state.selectedMedication)} is ${formatCurrency(copayAmountCents)}. I can complete the refill now.`,
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function handleCompleteRefill(
  state: RefillSessionState
): RefillWorkflowResult {
  return {
    updatedSession: {
      status: "completed",
      lastCompletedStep: "complete_refill",
      nextExpectedStep: "complete_refill"
    },
    agentReply: "Your refill request is complete. The pharmacy will follow up when it is ready.",
    isComplete: true,
    shouldCreateRefillRequest: hasCreateReadyFields(state)
  };
}

function continueAtStep(
  step: WorkflowStep,
  agentReply: string
): RefillWorkflowResult {
  return {
    updatedSession: { nextExpectedStep: step },
    agentReply,
    isComplete: false,
    shouldCreateRefillRequest: false
  };
}

function datesMatch(inputDate: string, expectedDate: string): boolean {
  const input = normalizeDate(inputDate);
  const expected = normalizeDate(expectedDate);

  return input !== undefined && expected !== undefined && input === expected;
}

function normalizeDate(value: string): string | undefined {
  const trimmed = value.trim();
  const isoMatch = trimmed.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);

  if (isoMatch) {
    return toDateKey(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const slashMatch = trimmed.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);

  if (slashMatch) {
    const year =
      slashMatch[3].length === 2 ? `19${slashMatch[3]}` : slashMatch[3];

    return toDateKey(year, slashMatch[1], slashMatch[2]);
  }

  return undefined;
}

function toDateKey(year: string, month: string, day: string): string {
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function findMedicationChoice(
  inputText: string,
  medications: MedicationChoice[]
): MedicationChoice | undefined {
  const normalizedInput = normalizeText(inputText);

  return medications.find((medication) => {
    const normalizedName = normalizeText(medication.medicationName);
    const normalizedStrength = normalizeText(medication.strength);

    return (
      normalizedInput.includes(normalizedName) ||
      normalizedInput.includes(`${normalizedName} ${normalizedStrength}`)
    );
  });
}

function parsePharmacyChoice(
  inputText: string,
  pharmacyOnFile: PharmacyChoice
): PharmacyChoice {
  if (isAffirmative(inputText) || normalizeText(inputText).includes("on file")) {
    return pharmacyOnFile;
  }

  return {
    name: inputText.trim(),
    isAlternate: true
  };
}

function resolveCopayAmountCents(
  medication: MedicationChoice,
  insurancePolicy: InsuranceSummary,
  copayRules: CopaySummary[]
): number | undefined {
  return copayRules.find(
    (copayRule) =>
      copayRule.prescriptionId === medication.prescriptionId &&
      copayRule.insurancePolicyId === insurancePolicy.insurancePolicyId
  )?.amountCents;
}

function getCopayPrompt(state: RefillSessionState): string {
  if (state.selectedMedication) {
    return `Thanks. I will check the copay for ${formatMedication(state.selectedMedication)}.`;
  }

  return "Thanks. I will check the copay before completing the refill.";
}

function hasCreateReadyFields(state: RefillSessionState): boolean {
  return (
    state.identityVerified &&
    state.selectedMedication !== undefined &&
    state.selectedPharmacy !== undefined &&
    state.insuranceVerified &&
    state.copayAmountCents !== undefined
  );
}

function isAffirmative(inputText: string): boolean {
  return AFFIRMATIVE_PATTERN.test(inputText);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatMedication(medication: MedicationChoice): string {
  return `${medication.medicationName} ${medication.strength}`;
}

function formatMedicationOptions(medications: MedicationChoice[]): string {
  return medications.map(formatMedication).join(", ");
}

function formatPharmacy(pharmacy: PharmacyChoice): string {
  if (pharmacy.addressLine1) {
    return `${pharmacy.name}, ${pharmacy.addressLine1}`;
  }

  return pharmacy.name;
}

function formatCurrency(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

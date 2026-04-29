// This module owns the refill workflow vocabulary and step ordering.
// UI, API routes, agents, and persistence code should import these values instead of redefining them.

export const CONVERSATION_CHANNELS = ["call", "sms"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const SESSION_STATUSES = ["active", "ended", "completed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const WORKFLOW_STEPS = [
  "verify_dob",
  "select_medication",
  "confirm_pharmacy",
  "verify_insurance",
  "notify_copay",
  "complete_refill"
] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface PatientSummary {
  id: number;
  fullName: string;
  dateOfBirth: string;
  phone: string;
}

export interface MedicationChoice {
  prescriptionId: number;
  medicationName: string;
  strength: string;
  directions: string;
}

export interface PharmacyChoice {
  pharmacyId?: number;
  name: string;
  addressLine1?: string;
  isAlternate?: boolean;
}

export interface RefillCompletionPayload {
  patient: PatientSummary;
  medication: MedicationChoice;
  pharmacy: PharmacyChoice;
  insuranceVerified: boolean;
  copayAmountCents: number;
  completedAt: string;
}

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

export interface RefillSessionState {
  channel: ConversationChannel;
  status: SessionStatus;
  identityVerified: boolean;
  verifiedAt?: string;
  selectedMedication?: MedicationChoice;
  selectedPharmacy?: PharmacyChoice;
  insuranceVerified: boolean;
  copayAmountCents?: number;
  lastCompletedStep?: WorkflowStep;
  nextExpectedStep: WorkflowStep;
}

export function createInitialSessionState(
  channel: ConversationChannel
): RefillSessionState {
  return {
    channel,
    status: "active",
    identityVerified: false,
    insuranceVerified: false,
    nextExpectedStep: WORKFLOW_STEPS[0]
  };
}

export function isConversationChannel(
  value: string
): value is ConversationChannel {
  return CONVERSATION_CHANNELS.includes(value as ConversationChannel);
}

export function isSessionStatus(value: string): value is SessionStatus {
  return SESSION_STATUSES.includes(value as SessionStatus);
}

export function isWorkflowStep(value: string): value is WorkflowStep {
  return WORKFLOW_STEPS.includes(value as WorkflowStep);
}

export function getStepIndex(step: WorkflowStep): number {
  return WORKFLOW_STEPS.indexOf(step);
}

export function getNextWorkflowStep(
  step: WorkflowStep
): WorkflowStep | undefined {
  return WORKFLOW_STEPS[getStepIndex(step) + 1];
}

export function hasSelectedMedication(
  state: Pick<RefillSessionState, "selectedMedication">
): state is { selectedMedication: MedicationChoice } {
  return state.selectedMedication !== undefined;
}

export function hasSelectedPharmacy(
  state: Pick<RefillSessionState, "selectedPharmacy">
): state is { selectedPharmacy: PharmacyChoice } {
  return state.selectedPharmacy !== undefined;
}

export function hasVerifiedIdentity(
  state: Pick<RefillSessionState, "identityVerified" | "verifiedAt">
): boolean {
  return state.identityVerified && state.verifiedAt !== undefined;
}

export function hasVerifiedInsurance(
  state: Pick<RefillSessionState, "insuranceVerified">
): boolean {
  return state.insuranceVerified;
}

export function hasCopayAmount(
  state: Pick<RefillSessionState, "copayAmountCents">
): state is { copayAmountCents: number } {
  return state.copayAmountCents !== undefined;
}

export function hasRequiredRefillFields(
  state: Pick<
    RefillSessionState,
    | "identityVerified"
    | "verifiedAt"
    | "selectedMedication"
    | "selectedPharmacy"
    | "insuranceVerified"
    | "copayAmountCents"
  >
): boolean {
  return (
    hasVerifiedIdentity(state) &&
    hasSelectedMedication(state) &&
    hasSelectedPharmacy(state) &&
    hasVerifiedInsurance(state) &&
    hasCopayAmount(state)
  );
}

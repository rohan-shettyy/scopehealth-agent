import assert from "node:assert/strict";
import test from "node:test";

import type { RefillWorkflowContext } from "@/domain/refill-engine";
import { createInitialSessionState } from "@/domain/workflow";
import {
  buildCallTurnInstruction,
  guardCallReply
} from "@/lib/voice/call-turn-instructions";

const context: RefillWorkflowContext = {
  patient: {
    id: 1,
    fullName: "Sarah Chen",
    dateOfBirth: "1985-03-15",
    phone: "(555) 867-5309"
  },
  activePrescriptions: [
    {
      prescriptionId: 1,
      medicationName: "Lisinopril",
      strength: "10mg",
      directions: "Take one tablet by mouth once daily"
    },
    {
      prescriptionId: 2,
      medicationName: "Metformin",
      strength: "500mg",
      directions: "Take one tablet by mouth twice daily"
    }
  ],
  pharmacyOnFile: {
    pharmacyId: 1,
    name: "CVS Pharmacy",
    addressLine1: "1234 Main St"
  },
  insurancePolicy: {
    insurancePolicyId: 1,
    payerName: "Aetna",
    planName: "PPO",
    memberId: "ANT-88912"
  },
  copayRules: [
    {
      prescriptionId: 1,
      insurancePolicyId: 1,
      amountCents: 500
    }
  ]
};

test("builds a structured call prompt with workflow state and limitations", () => {
  const instruction = buildCallTurnInstruction({
    state: {
      ...createInitialSessionState("call"),
      identityVerified: true,
      verifiedAt: "2026-04-29T12:00:00.000Z",
      selectedMedication: context.activePrescriptions[0],
      nextExpectedStep: "confirm_pharmacy"
    },
    context,
    patientUtterance: "Lisinopril",
    deterministicReply:
      "Got it, Lisinopril 10mg. Should I send it to CVS Pharmacy, 1234 Main St?"
  });

  assert.equal(instruction.currentStep, "confirm_pharmacy");
  assert.match(instruction.prompt, /Current workflow step: confirm_pharmacy/);
  assert.match(instruction.prompt, /selected medication Lisinopril 10mg/);
  assert.match(instruction.prompt, /Do not ask for information listed as already collected/);
});

test("falls back when model asks for already-known information", () => {
  const instruction = buildCallTurnInstruction({
    state: {
      ...createInitialSessionState("call"),
      identityVerified: true,
      verifiedAt: "2026-04-29T12:00:00.000Z",
      nextExpectedStep: "select_medication"
    },
    context,
    patientUtterance: "March fifteenth, nineteen eighty five",
    deterministicReply: "Thanks, I verified Sarah Chen. Which medication would you like to refill?"
  });
  const result = guardCallReply(
    instruction,
    "Can you tell me Sarah Chen's date of birth again?"
  );

  assert.equal(result.usedFallback, true);
  assert.equal(result.replyText, instruction.deterministicReply);
});

test("falls back when model jumps ahead to a later workflow step", () => {
  const instruction = buildCallTurnInstruction({
    state: createInitialSessionState("call"),
    context,
    patientUtterance: "hello",
    deterministicReply:
      "Hi, this is the prescription refill assistant. Please provide Sarah Chen's date of birth to get started."
  });
  const result = guardCallReply(
    instruction,
    "Which medication would you like to refill?"
  );

  assert.equal(result.usedFallback, true);
  assert.equal(result.replyText, instruction.deterministicReply);
});

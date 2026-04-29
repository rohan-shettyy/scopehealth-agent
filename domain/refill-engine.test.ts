import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceRefillWorkflow,
  type RefillWorkflowContext
} from "./refill-engine";
import { createInitialSessionState, type RefillSessionState } from "./workflow";

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
    },
    {
      prescriptionId: 2,
      insurancePolicyId: 1,
      amountCents: 1000
    }
  ]
};

test("verifies DOB and advances to medication selection", () => {
  const result = advanceRefillWorkflow(
    createInitialSessionState("call"),
    { text: "03/15/1985", receivedAt: "2026-04-29T12:00:00.000Z" },
    context
  );

  assert.equal(result.updatedSession.identityVerified, true);
  assert.equal(result.updatedSession.verifiedAt, "2026-04-29T12:00:00.000Z");
  assert.equal(result.updatedSession.lastCompletedStep, "verify_dob");
  assert.equal(result.updatedSession.nextExpectedStep, "select_medication");
  assert.equal(result.isComplete, false);
  assert.equal(result.shouldCreateRefillRequest, false);
});

test("selects a medication from active prescriptions", () => {
  const state: RefillSessionState = {
    ...createInitialSessionState("sms"),
    identityVerified: true,
    verifiedAt: "2026-04-29T12:00:00.000Z",
    nextExpectedStep: "select_medication"
  };

  const result = advanceRefillWorkflow(
    state,
    { text: "I need metformin" },
    context
  );

  assert.equal(result.updatedSession.selectedMedication?.medicationName, "Metformin");
  assert.equal(result.updatedSession.nextExpectedStep, "confirm_pharmacy");
  assert.match(result.agentReply, /Metformin 500mg/);
});

test("resolves copay and completes when all required fields are present", () => {
  const selectedMedication = context.activePrescriptions[0];
  const selectedPharmacy = context.pharmacyOnFile;
  const copayResult = advanceRefillWorkflow(
    {
      ...createInitialSessionState("call"),
      identityVerified: true,
      verifiedAt: "2026-04-29T12:00:00.000Z",
      selectedMedication,
      selectedPharmacy,
      insuranceVerified: true,
      nextExpectedStep: "notify_copay"
    },
    { text: "" },
    context
  );

  assert.equal(copayResult.updatedSession.copayAmountCents, 500);
  assert.equal(copayResult.updatedSession.nextExpectedStep, "complete_refill");

  const completeResult = advanceRefillWorkflow(
    {
      ...createInitialSessionState("call"),
      identityVerified: true,
      verifiedAt: "2026-04-29T12:00:00.000Z",
      selectedMedication,
      selectedPharmacy,
      insuranceVerified: true,
      copayAmountCents: 500,
      nextExpectedStep: "complete_refill"
    },
    { text: "complete it" },
    context
  );

  assert.equal(completeResult.updatedSession.status, "completed");
  assert.equal(completeResult.isComplete, true);
  assert.equal(completeResult.shouldCreateRefillRequest, true);
});

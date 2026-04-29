import { advanceRefillWorkflow } from "@/domain/refill-engine";
import { normalizeReadableTranscript } from "@/domain/spoken-date";
import type { RefillSessionState, WorkflowStep } from "@/domain/workflow";
import {
  buildCallSystemInstruction,
  buildCallTurnInstruction,
  guardCallReply
} from "@/lib/voice/call-turn-instructions";
import { advanceRefillWorkflowWithGemini } from "@/lib/gemini-workflow-orchestrator";
import {
  appendConversationMessage,
  createConversationSession,
  createRefillRequestFromSession,
  endCallSession,
  fetchSessionTranscript,
  loadDemoPatientWorkflowContext,
  switchSessionToSms,
  updateConversationSessionState,
  type ConversationSessionSnapshot,
  type RefillRequestSnapshot,
  type SessionTranscript
} from "@/lib/refill-persistence";
import { getCallVoiceProvider } from "@/lib/voice/provider";
import { generateTextWithGemini } from "@/lib/voice/gemini-text-client";
import type { VoiceLiveEvent } from "@/lib/voice/types";

export interface WorkflowInteractionResult {
  session: ConversationSessionSnapshot;
  agentReply: string;
  isComplete: boolean;
  refillRequest?: RefillRequestSnapshot;
  voiceEvents?: VoiceLiveEvent[];
}

export interface StartCallResult extends SessionTranscript {
  voiceEvents?: VoiceLiveEvent[];
}

export async function startSimulatedCall(): Promise<StartCallResult> {
  const context = await loadDemoPatientWorkflowContext();
  const session = await createConversationSession({
    patientId: context.patient.id,
    channel: "call"
  });
  const agentReply =
    "Hi, this is the prescription refill assistant. Please provide Sarah Chen's date of birth to get started.";

  await createCallVoiceSession(session.id);
  const greetingInstruction = buildCallTurnInstruction({
    state: session.state,
    context,
    patientUtterance: "The call just connected.",
    deterministicReply: agentReply
  });
  const voiceResult = await phraseCallReply(
    session.id,
    "The call just connected.",
    agentReply,
    greetingInstruction.prompt
  );
  const guardedReply = guardCallReply(greetingInstruction, voiceResult.replyText);

  await appendConversationMessage({
    sessionId: session.id,
    role: "assistant",
    content: guardedReply.replyText
  });
  await persistGuardrailFallback(session.id, guardedReply);
  await persistVoiceEvents(session.id, voiceResult.events);

  return {
    ...(await fetchSessionTranscript(session.id)),
    voiceEvents: voiceResult.events
  };
}

export async function submitCallInput(
  sessionId: number,
  text: string
): Promise<WorkflowInteractionResult> {
  return submitWorkflowInput(sessionId, text, "call");
}

export async function streamCallAudioChunk(input: {
  sessionId: number;
  audioBase64: string;
  mimeType: string;
}): Promise<{ voiceEvents: VoiceLiveEvent[] }> {
  const transcript = await fetchSessionTranscript(input.sessionId);

  if (
    transcript.session.state.channel !== "call" ||
    transcript.session.state.status !== "active"
  ) {
    throw new Error("Call session is not active");
  }

  try {
    await getCallVoiceProvider().sendAudioChunk(input);
  } catch (error) {
    return {
      voiceEvents: [
        {
          sessionId: input.sessionId,
          provider: "gemini-live",
          type: "error",
          text: formatError(error),
          createdAt: new Date().toISOString()
        }
      ]
    };
  }

  return {
    voiceEvents: await getCallVoiceProvider().getEvents(input.sessionId)
  };
}

export async function finishCallAudioTurn(
  sessionId: number
): Promise<WorkflowInteractionResult> {
  const audioResult = await getCallVoiceProvider().endAudioTurn(sessionId);
  const transcriptText = normalizeReadableTranscript(
    audioResult.transcriptText?.trim() ?? ""
  ).trim();

  if (!transcriptText) {
    await persistVoiceEvents(sessionId, audioResult.events);
    throw new Error("No speech transcription was returned for this audio turn");
  }

  const workflowResult = await submitCallInput(sessionId, transcriptText);

  return {
    ...workflowResult,
    voiceEvents: [
      ...getPatientAudioTranscriptEvents(audioResult.events),
      ...(workflowResult.voiceEvents ?? [])
    ]
  };
}

export async function getCallVoiceEvents(
  sessionId: number
): Promise<{ voiceEvents: VoiceLiveEvent[] }> {
  return {
    voiceEvents: await getCallVoiceProvider().getEvents(sessionId)
  };
}

export async function submitSmsReply(
  sessionId: number,
  text: string
): Promise<WorkflowInteractionResult> {
  return submitWorkflowInput(sessionId, text, "sms");
}

export async function hangUpCall(sessionId: number): Promise<SessionTranscript> {
  const transcript = await fetchSessionTranscript(sessionId);

  if (transcript.session.state.channel !== "call") {
    throw new Error("Only call sessions can be hung up");
  }

  if (transcript.session.state.status === "completed") {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: "Call ended after workflow completion."
    });

    return fetchSessionTranscript(sessionId);
  }

  await appendConversationMessage({
    sessionId,
    role: "system",
    content: "Call disconnected; SMS fallback activated."
  });
  await endCallSession(sessionId);
  await closeCallVoiceSession(sessionId);
  return triggerSmsFallback(sessionId);
}

export async function resetSimulatedCall(sessionId: number): Promise<{ reset: true }> {
  const transcript = await fetchSessionTranscript(sessionId);

  if (
    transcript.session.state.channel === "call" &&
    transcript.session.state.status === "active"
  ) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: "Demo call reset; abandoning this session without SMS fallback."
    });
    await endCallSession(sessionId);
    await closeCallVoiceSession(sessionId);
  }

  return { reset: true };
}

export async function triggerSmsFallback(
  sessionId: number
): Promise<SessionTranscript> {
  const transcript = await fetchSessionTranscript(sessionId);

  if (transcript.session.state.status === "completed") {
    return transcript;
  }

  const session =
    transcript.session.state.channel === "sms" &&
    transcript.session.state.status === "active"
      ? transcript.session
      : await switchSessionToSms(sessionId);
  const context = await loadDemoPatientWorkflowContext();
  const agentReply =
    (await getGeminiSmsContinuationPrompt(session.state, context)) ??
    getContinuationPrompt(session.state, context);

  if (!hasMessage(await fetchSessionTranscript(sessionId), agentReply)) {
    await appendConversationMessage({
      sessionId,
      role: "assistant",
      content: agentReply
    });
  }

  return fetchSessionTranscript(sessionId);
}

export async function getSessionTranscript(
  sessionId: number
): Promise<SessionTranscript> {
  return fetchSessionTranscript(sessionId);
}

async function submitWorkflowInput(
  sessionId: number,
  text: string,
  expectedChannel: "call" | "sms"
): Promise<WorkflowInteractionResult> {
  const transcript = await fetchSessionTranscript(sessionId);

  if (transcript.session.state.channel !== expectedChannel) {
    throw new Error(`Session is not in ${expectedChannel} mode`);
  }

  if (transcript.session.state.status !== "active") {
    throw new Error("Session is not active");
  }

  await appendConversationMessage({
    sessionId,
    role: "user",
    content: text
  });

  const context = await loadDemoPatientWorkflowContext();
  const firstResult = await advanceRefillWorkflowWithGemini(
    transcript.session.state,
    {
      text,
      receivedAt: new Date().toISOString()
    },
    context,
    expectedChannel
  );
  if (!firstResult.usedGemini) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: "Gemini workflow orchestration unavailable; deterministic workflow fallback used for this turn."
    });
  }
  const firstSession = await updateConversationSessionState(
    sessionId,
    firstResult.updatedSession
  );
  const result =
    firstSession.state.nextExpectedStep === "notify_copay" &&
    !firstSession.state.copayAmountCents
      ? await advanceGeneratedWorkflowStep(sessionId, firstSession.state)
      : {
          session: firstSession,
          agentReply: firstResult.agentReply,
          isComplete: firstResult.isComplete,
          shouldCreateRefillRequest: firstResult.shouldCreateRefillRequest
        };
  const voiceResult =
    expectedChannel === "call"
      ? firstResult.usedGemini
        ? await phraseCallReplyForGeminiState(
            sessionId,
            text,
            result.agentReply,
            result.session.state,
            context
          )
        : await phraseCallReplyForState(
          sessionId,
          text,
          result.agentReply,
          result.session.state,
          context
          )
      : { replyText: result.agentReply, events: [] };

  await appendConversationMessage({
    sessionId,
    role: "assistant",
    content: voiceResult.replyText
  });
  await persistVoiceEvents(sessionId, voiceResult.events);

  const refillRequest = result.shouldCreateRefillRequest
    ? await createRefillRequestFromSession(sessionId)
    : undefined;

  return {
    session: refillRequest
      ? (await fetchSessionTranscript(sessionId)).session
      : result.session,
    agentReply: voiceResult.replyText,
    isComplete: result.isComplete,
    refillRequest,
    voiceEvents: voiceResult.events
  };
}

async function advanceGeneratedWorkflowStep(
  sessionId: number,
  state: RefillSessionState
) {
  const context = await loadDemoPatientWorkflowContext();
  const result = advanceRefillWorkflow(state, { text: "" }, context);
  const session = await updateConversationSessionState(
    sessionId,
    result.updatedSession
  );

  return {
    session,
    agentReply: result.agentReply,
    isComplete: result.isComplete,
    shouldCreateRefillRequest: result.shouldCreateRefillRequest
  };
}

function getContinuationPrompt(
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadDemoPatientWorkflowContext>>
): string {
  const medication = state.selectedMedication
    ? `${state.selectedMedication.medicationName} ${state.selectedMedication.strength}`
    : undefined;
  const pharmacy = state.selectedPharmacy
    ? formatPharmacyForMessage(state.selectedPharmacy)
    : undefined;
  const copay = state.copayAmountCents !== undefined
    ? formatCurrencyForMessage(state.copayAmountCents)
    : undefined;

  switch (getNextMissingStep(state)) {
    case "verify_dob":
      return "Looks like we got disconnected. To continue Sarah Chen's refill, please reply with her date of birth.";
    case "select_medication":
      return `Looks like we got disconnected. Which medication would you like to refill? ${context.activePrescriptions
        .map((option) => `${option.medicationName} ${option.strength}`)
        .join(", ")}.`;
    case "confirm_pharmacy":
      return `Looks like we got disconnected. I have your ${medication ?? "refill"} started. Should I send it to ${context.pharmacyOnFile.name}, ${context.pharmacyOnFile.addressLine1}?`;
    case "verify_insurance":
      return `Looks like we got disconnected. I have ${medication ?? "the refill"} set for ${pharmacy ?? formatPharmacyForMessage(context.pharmacyOnFile)}. Is your ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName} insurance still current?`;
    case "notify_copay":
      return `Looks like we got disconnected. Reply anything when you are ready and I will send the copay${medication ? ` for ${medication}` : ""}.`;
    case "complete_refill":
      return `Thanks. ${copay && medication ? `Your copay for ${medication} is ${copay}. ` : ""}Reply YES to finish your refill request${pharmacy ? ` with ${pharmacy}` : ""}.`;
  }
}

async function getGeminiSmsContinuationPrompt(
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadDemoPatientWorkflowContext>>
) {
  return generateTextWithGemini(
    [
      "You are the SMS continuation assistant for a prescription refill demo.",
      "Use gemini-3.1-flash-lite-preview behavior: concise, reliable, and text-message friendly.",
      "Continue from the existing state. Do not re-ask collected information.",
      "Only discuss DOB verification, medication, pharmacy, insurance, copay, or refill completion.",
      "Return only the SMS message text. No markdown."
    ].join("\n"),
    JSON.stringify(
      {
        currentState: state,
        patient: context.patient,
        activePrescriptions: context.activePrescriptions,
        pharmacyOnFile: context.pharmacyOnFile,
        insurancePolicy: context.insurancePolicy,
        copayRules: context.copayRules,
        nextMissingStep: getNextMissingStep(state)
      },
      null,
      2
    ),
    {
      temperature: 0.35,
      maxOutputTokens: 180
    }
  );
}

function getNextMissingStep(state: RefillSessionState): WorkflowStep {
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

function hasMessage(transcript: SessionTranscript, content: string): boolean {
  return transcript.messages.some((message) => message.content === content);
}

async function createCallVoiceSession(sessionId: number) {
  try {
    const voiceSession = await getCallVoiceProvider().createSession({
      sessionId,
      systemInstruction: buildCallSystemInstruction()
    });

    if (voiceSession.provider === "local-fallback") {
      await appendConversationMessage({
        sessionId,
        role: "system",
        content:
          "Gemini Live is not enabled for this server process. Continuing in text-input call mode; microphone transcription and spoken audio require ENABLE_GEMINI_LIVE=true and GEMINI_API_KEY."
      });
    }
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Gemini Live unavailable; continuing in text-input call mode. ${formatError(error)}`
    });
  }
}

async function phraseCallReply(
  sessionId: number,
  userText: string,
  deterministicReply: string,
  instructionPrompt: string
) {
  try {
    return await getCallVoiceProvider().sendUserTurn({
      sessionId,
      userText,
      deterministicReply,
      instructionPrompt
    });
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Gemini voice turn failed; showing deterministic text reply. ${formatError(error)}`
    });

    return {
      replyText: deterministicReply,
      events: []
    };
  }
}

async function phraseCallReplyForState(
  sessionId: number,
  userText: string,
  deterministicReply: string,
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadDemoPatientWorkflowContext>>
) {
  const instruction = buildCallTurnInstruction({
    state,
    context,
    patientUtterance: userText,
    deterministicReply
  });
  const voiceResult = await phraseCallReply(
    sessionId,
    userText,
    deterministicReply,
    instruction.prompt
  );
  const guardedReply = guardCallReply(instruction, voiceResult.replyText);

  await persistGuardrailFallback(sessionId, guardedReply);

  return {
    ...voiceResult,
    replyText: guardedReply.replyText
  };
}

async function phraseCallReplyForGeminiState(
  sessionId: number,
  userText: string,
  geminiReply: string,
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadDemoPatientWorkflowContext>>
) {
  return phraseCallReply(
    sessionId,
    userText,
    geminiReply,
    [
      "Gemini is the primary call agent for this simulated refill call.",
      "Speak naturally and briefly as a healthcare administrative phone agent.",
      "Use this exact workflow state as context, but do not mention JSON, tools, or implementation details.",
      "Do not ask for information already collected.",
      "Do not provide medical advice.",
      `Current state: ${JSON.stringify(state)}`,
      `Patient: ${context.patient.fullName}`,
      `Available medications: ${context.activePrescriptions
        .map((prescription) => `${prescription.medicationName} ${prescription.strength}`)
        .join(", ")}`,
      `Pharmacy on file: ${context.pharmacyOnFile.name}, ${context.pharmacyOnFile.addressLine1}`,
      `Insurance: ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName}`,
      `Patient said: ${userText}`,
      `Say this meaning, with natural phone phrasing: ${geminiReply}`
    ].join("\n")
  );
}

async function persistGuardrailFallback(
  sessionId: number,
  result: ReturnType<typeof guardCallReply>
) {
  if (!result.usedFallback) {
    return;
  }

  await appendConversationMessage({
    sessionId,
    role: "system",
    content: `Voice model reply overridden by call guardrails: ${result.reason ?? "unspecified"}`
  });
}

async function closeCallVoiceSession(sessionId: number) {
  try {
    const events = await getCallVoiceProvider().closeSession(sessionId);
    await persistVoiceEvents(sessionId, events);
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Gemini Live cleanup failed after call end. ${formatError(error)}`
    });
  }
}

async function persistVoiceEvents(
  sessionId: number,
  events: VoiceLiveEvent[]
) {
  for (const event of events) {
    if (event.type === "tool_call") {
      await appendConversationMessage({
        sessionId,
        role: "tool",
        content: `Voice tool call event: ${JSON.stringify(event.toolCalls ?? [])}`
      });
    }

    if (event.type === "error") {
      await appendConversationMessage({
        sessionId,
        role: "system",
        content: `Voice provider error: ${formatVoiceEventError(event)}`
      });
    }
  }
}

function formatVoiceEventError(event: VoiceLiveEvent): string {
  if (event.text) {
    return event.text;
  }

  if (typeof event.raw === "string") {
    return event.raw;
  }

  if (event.raw && typeof event.raw === "object") {
    return JSON.stringify(event.raw);
  }

  return "Unknown voice provider error";
}

function getPatientAudioTranscriptEvents(events: VoiceLiveEvent[]) {
  return events
    .filter((event) => event.type === "user_transcript" || event.type === "error")
    .map((event) =>
      event.type === "user_transcript" && event.text
        ? {
            ...event,
            text: normalizeReadableTranscript(event.text)
          }
        : event
    );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function formatPharmacyForMessage(pharmacy: {
  name: string;
  addressLine1?: string;
}) {
  return pharmacy.addressLine1
    ? `${pharmacy.name}, ${pharmacy.addressLine1}`
    : pharmacy.name;
}

function formatCurrencyForMessage(amountCents: number) {
  return `$${(amountCents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

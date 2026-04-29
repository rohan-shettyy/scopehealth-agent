import { advanceRefillWorkflow } from "@/domain/refill-engine";
import type { RefillSessionState, WorkflowStep } from "@/domain/workflow";
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
import type { VoiceLiveEvent } from "@/lib/voice/types";

export interface WorkflowInteractionResult {
  session: ConversationSessionSnapshot;
  agentReply: string;
  isComplete: boolean;
  refillRequest?: RefillRequestSnapshot;
  voiceEvents?: VoiceLiveEvent[];
}

export async function startSimulatedCall(): Promise<SessionTranscript> {
  const context = await loadDemoPatientWorkflowContext();
  const session = await createConversationSession({
    patientId: context.patient.id,
    channel: "call"
  });
  const agentReply =
    "Hi, this is the prescription refill assistant. Please provide Sarah Chen's date of birth to get started.";

  await appendConversationMessage({
    sessionId: session.id,
    role: "assistant",
    content: agentReply
  });
  await createCallVoiceSession(session.id);

  return fetchSessionTranscript(session.id);
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

  await getCallVoiceProvider().sendAudioChunk(input);

  return {
    voiceEvents: await getCallVoiceProvider().getEvents(input.sessionId)
  };
}

export async function finishCallAudioTurn(
  sessionId: number
): Promise<WorkflowInteractionResult> {
  const audioResult = await getCallVoiceProvider().endAudioTurn(sessionId);
  const transcriptText = audioResult.transcriptText?.trim();

  if (!transcriptText) {
    await persistVoiceEvents(sessionId, audioResult.events);
    throw new Error("No speech transcription was returned for this audio turn");
  }

  const workflowResult = await submitCallInput(sessionId, transcriptText);

  return {
    ...workflowResult,
    voiceEvents: [...audioResult.events, ...(workflowResult.voiceEvents ?? [])]
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

  await endCallSession(sessionId);
  await closeCallVoiceSession(sessionId);
  return triggerSmsFallback(sessionId);
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
  const agentReply = getContinuationPrompt(session.state, context);

  if (!hasMessage(transcript, agentReply)) {
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
  const firstResult = advanceRefillWorkflow(
    transcript.session.state,
    {
      text,
      receivedAt: new Date().toISOString()
    },
    context
  );
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
      ? await phraseCallReply(sessionId, text, result.agentReply)
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

  switch (getNextMissingStep(state)) {
    case "verify_dob":
      return "We got disconnected. To continue Sarah Chen's refill, please reply with her date of birth.";
    case "select_medication":
      return `We got disconnected. Which medication would you like to refill? ${context.activePrescriptions
        .map((option) => `${option.medicationName} ${option.strength}`)
        .join(", ")}.`;
    case "confirm_pharmacy":
      return `We got disconnected. Should I send ${medication ?? "the refill"} to ${context.pharmacyOnFile.name}, ${context.pharmacyOnFile.addressLine1}?`;
    case "verify_insurance":
      return `We got disconnected. Is your ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName} insurance still current${medication ? ` for ${medication}` : ""}?`;
    case "notify_copay":
      return `We got disconnected. Reply anything when you are ready and I will send the copay${medication ? ` for ${medication}` : ""}.`;
    case "complete_refill":
      return `We got disconnected. Reply to complete the refill${medication ? ` for ${medication}` : ""}.`;
  }
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
      systemInstruction: [
        "You are a concise voice assistant for a prescription refill demo.",
        "The deterministic workflow engine controls all refill state.",
        "Only rephrase supplied agent replies for natural phone conversation.",
        "Do not invent medical, insurance, pharmacy, or workflow decisions."
      ].join(" ")
    });

    if (voiceSession.provider === "local-fallback") {
      await appendConversationMessage({
        sessionId,
        role: "system",
        content:
          "Gemini Live is not enabled for this server process. Text turns still work, but microphone transcription requires ENABLE_GEMINI_LIVE=true and GEMINI_API_KEY."
      });
    }
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Voice provider unavailable; using deterministic call text. ${formatError(error)}`
    });
  }
}

async function phraseCallReply(
  sessionId: number,
  userText: string,
  deterministicReply: string
) {
  try {
    return await getCallVoiceProvider().sendUserTurn({
      sessionId,
      userText,
      deterministicReply
    });
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Voice provider turn failed; using deterministic reply. ${formatError(error)}`
    });

    return {
      replyText: deterministicReply,
      events: []
    };
  }
}

async function closeCallVoiceSession(sessionId: number) {
  try {
    const events = await getCallVoiceProvider().closeSession(sessionId);
    await persistVoiceEvents(sessionId, events);
  } catch (error) {
    await appendConversationMessage({
      sessionId,
      role: "system",
      content: `Voice provider close failed. ${formatError(error)}`
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

import { normalizeReadableTranscript } from "@/domain/spoken-date";
import type { RefillSessionState, WorkflowStep } from "@/domain/workflow";
import { buildCallSystemInstruction } from "@/lib/voice/call-turn-instructions";
import {
  advanceGeminiRefillWorkflow,
  identifyPatientForRefillWorkflow
} from "@/lib/gemini-workflow-orchestrator";
import {
  DuplicateRefillRequestError,
  appendConversationMessage,
  attachPatientToConversationSession,
  createConversationSession,
  createRefillRequestFromSession,
  endCallSession,
  fetchSessionTranscript,
  loadAllPatientIdentitySummaries,
  loadCallTranscriptCorrectionTerms,
  loadCallTranscriptionVocabulary,
  loadPatientWorkflowContextById,
  switchSessionToSms,
  updateConversationSessionState,
  type ConversationSessionSnapshot,
  type RefillRequestSnapshot,
  type SessionTranscript
} from "@/lib/refill-persistence";
import { getCallVoiceProvider } from "@/lib/voice/provider";
import { generateTextWithGemini } from "@/lib/voice/gemini-text-client";
import type { VoiceLiveEvent } from "@/lib/voice/types";

interface WorkflowInteractionResult {
  session: ConversationSessionSnapshot;
  agentReply: string;
  isComplete: boolean;
  refillRequest?: RefillRequestSnapshot;
  voiceEvents?: VoiceLiveEvent[];
}

interface StartCallResult extends SessionTranscript {
  voiceEvents?: VoiceLiveEvent[];
}

export async function startSimulatedCall(): Promise<StartCallResult> {
  const session = await createConversationSession({
    channel: "call"
  });
  const agentReply =
    "Hi, this is the prescription refill assistant. Please say your full name and date of birth to get started.";

  await createCallVoiceSession(session.id);
  const voiceResult = await phraseCallReply(
    session.id,
    "The call just connected.",
    agentReply,
    [
      "The call just connected.",
      "Greet the caller and ask for their full name and date of birth to identify their patient profile.",
      "Keep it brief and natural for a phone call."
    ].join("\n")
  );

  await appendConversationMessage({
    sessionId: session.id,
    role: "assistant",
    content: voiceResult.replyText
  });
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
  const transcriptText = await normalizeCallTranscript(
    audioResult.transcriptText?.trim() ?? ""
  );

  if (!transcriptText) {
    await persistVoiceEvents(sessionId, audioResult.events);
    return repromptAfterNoSpeech(sessionId, audioResult.events);
  }

  const workflowResult = await submitCallInput(sessionId, transcriptText);

  return {
    ...workflowResult,
    voiceEvents: [
      ...getCanonicalPatientAudioTranscriptEvents(audioResult.events, transcriptText),
      ...(workflowResult.voiceEvents ?? [])
    ]
  };
}

async function repromptAfterNoSpeech(
  sessionId: number,
  audioEvents: VoiceLiveEvent[]
): Promise<WorkflowInteractionResult> {
  const transcript = await fetchSessionTranscript(sessionId);
  const context = transcript.session.patientId
    ? await loadPatientWorkflowContextById(transcript.session.patientId)
    : undefined;
  const reprompt = getNoSpeechReprompt(transcript.session.state);
  const voiceResult = await phraseCallReply(
    sessionId,
    "No clear patient speech was transcribed.",
    reprompt,
    [
      "The patient did not produce clear transcribable speech.",
      "Do not advance the refill workflow.",
      "Briefly re-prompt for the current missing information.",
      `Current workflow state: ${JSON.stringify(transcript.session.state)}`,
      context ? `Patient: ${context.patient.fullName}` : "Patient: unidentified",
      context
        ? `Available medications: ${context.activePrescriptions
            .map((prescription) => `${prescription.medicationName} ${prescription.strength}`)
            .join(", ")}`
        : "Available medications: unknown until patient identity is verified",
      context
        ? `Pharmacy on file: ${context.pharmacyOnFile.name}, ${context.pharmacyOnFile.addressLine1}`
        : "Pharmacy on file: unknown until patient identity is verified",
      context
        ? `Insurance: ${context.insurancePolicy.payerName} ${context.insurancePolicy.planName}`
        : "Insurance: unknown until patient identity is verified",
      `Required reply meaning: ${reprompt}`
    ].join("\n")
  );

  await appendConversationMessage({
    sessionId,
    role: "assistant",
    content: voiceResult.replyText
  });
  await persistVoiceEvents(sessionId, voiceResult.events);

  return {
    session: transcript.session,
    agentReply: voiceResult.replyText,
    isComplete: false,
    refillRequest: transcript.refillRequest,
    voiceEvents: [...audioEvents, ...voiceResult.events]
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
  const agentReply = session.patientId
    ? await getGeminiSmsContinuationPrompt(
        session.state,
        await loadPatientWorkflowContextById(session.patientId)
      )
    : "Looks like we got disconnected. To continue your refill by text, please reply with your full name and date of birth.";

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

  if (!transcript.session.patientId || !transcript.session.state.identityVerified) {
    return identifyPatientForSession(sessionId, text, expectedChannel);
  }

  const context = await loadPatientWorkflowContextById(transcript.session.patientId);
  const firstResult = await advanceGeminiRefillWorkflow(
    transcript.session.state,
    {
      text,
      receivedAt: new Date().toISOString()
    },
    context,
    expectedChannel
  );
  const firstSession = await updateConversationSessionState(
    sessionId,
    firstResult.updatedSession
  );
  const result = {
    session: firstSession,
    agentReply: firstResult.agentReply,
    isComplete: firstResult.isComplete,
    shouldCreateRefillRequest: firstResult.shouldCreateRefillRequest
  };
  const voiceResult =
    expectedChannel === "call"
      ? await phraseCallReplyForGeminiState(
            sessionId,
            text,
            result.agentReply,
            result.session.state,
            context
          )
      : { replyText: result.agentReply, events: [] };

  const completion = result.shouldCreateRefillRequest
    ? await createRefillRequestWithDuplicateDenial(
        sessionId,
        expectedChannel,
        context
      )
    : { voiceEvents: [] };

  if (completion.denialReply) {
    return {
      session: (await fetchSessionTranscript(sessionId)).session,
      agentReply: completion.denialReply,
      isComplete: false,
      refillRequest: completion.refillRequest,
      voiceEvents: completion.voiceEvents
    };
  }

  await appendConversationMessage({
    sessionId,
    role: "assistant",
    content: voiceResult.replyText
  });
  await persistVoiceEvents(sessionId, voiceResult.events);

  const finalVoiceEvents = [...voiceResult.events, ...(completion.voiceEvents ?? [])];

  return {
    session: completion.refillRequest || completion.denialReply
      ? (await fetchSessionTranscript(sessionId)).session
      : result.session,
    agentReply: completion.denialReply ?? voiceResult.replyText,
    isComplete: completion.denialReply ? false : result.isComplete,
    refillRequest: completion.refillRequest,
    voiceEvents: finalVoiceEvents
  };
}

async function normalizeCallTranscript(value: string): Promise<string> {
  const readable = normalizeReadableTranscript(value).trim();

  if (!readable) {
    return "";
  }

  return correctKnownTranscriptTerms(
    readable,
    await loadCallTranscriptCorrectionTerms()
  );
}

function correctKnownTranscriptTerms(value: string, terms: string[]): string {
  return terms.reduce(
    (current, term) => replaceCloseTranscriptTerm(current, term),
    value
  );
}

function replaceCloseTranscriptTerm(value: string, term: string): string {
  const termTokens = splitWords(term);
  const words = [...value.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?/g)];
  let result = value;
  let offset = 0;

  for (let index = 0; index < words.length; index += 1) {
      const maxWindow = Math.min(
        words.length - index,
        termTokens.length + (term.length >= 10 ? 4 : 2)
      );

    for (let size = maxWindow; size >= 1; size -= 1) {
      const window = words.slice(index, index + size);
      const candidate = window.map((match) => match[0]).join(" ");

      if (!isCloseTranscriptTerm(candidate, term)) {
        continue;
      }

      const start = (window[0].index ?? 0) + offset;
      const last = window[window.length - 1];
      const end = (last.index ?? 0) + last[0].length + offset;
      result = `${result.slice(0, start)}${term}${result.slice(end)}`;
      offset += term.length - (end - start);
      index += size - 1;
      break;
    }
  }

  return result;
}

function isCloseTranscriptTerm(candidate: string, term: string): boolean {
  const normalizedCandidate = normalizeLetters(candidate);
  const normalizedTerm = normalizeLetters(term);

  if (!normalizedCandidate || !normalizedTerm) {
    return false;
  }

  if (
    normalizedCandidate === normalizedTerm ||
    normalizedCandidate.includes(normalizedTerm) ||
    normalizedTerm.includes(normalizedCandidate)
  ) {
    return normalizedCandidate.length >= Math.min(normalizedTerm.length, 4);
  }

  const distance = levenshteinDistance(normalizedCandidate, normalizedTerm);
  const similarity =
    1 - distance / Math.max(normalizedCandidate.length, normalizedTerm.length);
  const threshold = normalizedTerm.length >= 10 ? 0.74 : 0.82;

  return similarity >= threshold;
}

function splitWords(value: string): string[] {
  return value.match(/[A-Za-z]+/g) ?? [];
}

function normalizeLetters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

async function identifyPatientForSession(
  sessionId: number,
  text: string,
  expectedChannel: "call" | "sms"
): Promise<WorkflowInteractionResult> {
  const patients = await loadAllPatientIdentitySummaries();
  const identity = await identifyPatientForRefillWorkflow(
    { text },
    patients,
    expectedChannel
  );
  const now = new Date().toISOString();

  if (!identity.patient) {
    const voiceResult =
      expectedChannel === "call"
        ? await phraseCallReply(
            sessionId,
            text,
            identity.agentReply,
            [
              "The caller has not been matched to a patient profile yet.",
              "Ask only for their full name and date of birth.",
              `Patient said: ${text}`,
              `Say this meaning, with natural phone phrasing: ${identity.agentReply}`
            ].join("\n")
          )
        : { replyText: identity.agentReply, events: [] };

    await appendConversationMessage({
      sessionId,
      role: "assistant",
      content: voiceResult.replyText
    });
    await persistVoiceEvents(sessionId, voiceResult.events);

    return {
      session: (await fetchSessionTranscript(sessionId)).session,
      agentReply: voiceResult.replyText,
      isComplete: false,
      voiceEvents: voiceResult.events
    };
  }

  const context = await loadPatientWorkflowContextById(identity.patient.id);
  const updatedSession = await attachPatientToConversationSession(
    sessionId,
    identity.patient.id,
    {
      identityVerified: true,
      verifiedAt: now,
      lastCompletedStep: "identify_patient",
      nextExpectedStep: "select_medication"
    }
  );
  const medicationList = context.activePrescriptions
    .map((prescription) => `${prescription.medicationName} ${prescription.strength}`)
    .join(", ");
  const requiredReply = `Thanks, ${context.patient.fullName}. I found your profile. Which medication would you like to refill? Your active prescriptions are ${medicationList}.`;
  const voiceResult =
    expectedChannel === "call"
      ? await phraseCallReplyForGeminiState(
          sessionId,
          text,
          requiredReply,
          updatedSession.state,
          context
        )
      : { replyText: requiredReply, events: [] };

  await appendConversationMessage({
    sessionId,
    role: "assistant",
    content: voiceResult.replyText
  });
  await persistVoiceEvents(sessionId, voiceResult.events);

  return {
    session: updatedSession,
    agentReply: voiceResult.replyText,
    isComplete: false,
    voiceEvents: voiceResult.events
  };
}

async function createRefillRequestWithDuplicateDenial(
  sessionId: number,
  expectedChannel: "call" | "sms",
  context: Awaited<ReturnType<typeof loadPatientWorkflowContextById>>
): Promise<{
  refillRequest?: RefillRequestSnapshot;
  denialReply?: string;
  voiceEvents?: VoiceLiveEvent[];
}> {
  try {
    return { refillRequest: await createRefillRequestFromSession(sessionId) };
  } catch (error) {
    if (!(error instanceof DuplicateRefillRequestError)) {
      throw error;
    }

    const transcript = await fetchSessionTranscript(sessionId);

    if (transcript.refillRequest) {
      return {
        refillRequest: transcript.refillRequest,
        voiceEvents: []
      };
    }

    const denialReply = error.message;
    await updateConversationSessionState(sessionId, { status: "active" });
    const voiceResult =
      expectedChannel === "call"
        ? await phraseCallReplyForGeminiState(
            sessionId,
            "The requested prescription already has an existing refill request.",
            denialReply,
            (await fetchSessionTranscript(sessionId)).session.state,
            context
          )
        : { replyText: denialReply, events: [] };

    await appendConversationMessage({
      sessionId,
      role: "assistant",
      content: voiceResult.replyText
    });
    await persistVoiceEvents(sessionId, voiceResult.events);

    return {
      denialReply: voiceResult.replyText,
      voiceEvents: voiceResult.events
    };
  }
}

async function getGeminiSmsContinuationPrompt(
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadPatientWorkflowContextById>>
) {
  const reply = await generateTextWithGemini(
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

  if (!reply) {
    throw new Error("Gemini SMS continuation did not return a response");
  }

  return reply;
}

function getNextMissingStep(state: RefillSessionState): WorkflowStep {
  if (!state.identityVerified) {
    return "identify_patient";
  }

  if (!state.selectedMedication && !state.selectedMedications?.length) {
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

function getNoSpeechReprompt(state: RefillSessionState): string {
  switch (getNextMissingStep(state)) {
    case "identify_patient":
      return "I did not catch that. Please say your full name and date of birth.";
    case "select_medication":
      return "I did not catch that. Which medication would you like to refill?";
    case "confirm_pharmacy":
      return "I did not catch that. Should I use the pharmacy on file, or a different pharmacy?";
    case "verify_insurance":
      return "I did not catch that. Is your insurance still current?";
    case "notify_copay":
      return "I did not catch that. I can share the copay and continue when you are ready.";
    case "complete_refill":
      return "I did not catch that. Please say yes when you are ready to finish the refill request.";
  }
}

function hasMessage(transcript: SessionTranscript, content: string): boolean {
  return transcript.messages.some((message) => message.content === content);
}

async function createCallVoiceSession(sessionId: number) {
  try {
    const vocabulary = await loadCallTranscriptionVocabulary();
    const voiceSession = await getCallVoiceProvider().createSession({
      sessionId,
      systemInstruction: buildCallSystemInstruction(vocabulary)
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
  requiredReply: string,
  instructionPrompt: string
) {
  return getCallVoiceProvider().sendUserTurn({
    sessionId,
    userText,
    requiredReply,
    instructionPrompt
  });
}

async function phraseCallReplyForGeminiState(
  sessionId: number,
  userText: string,
  geminiReply: string,
  state: RefillSessionState,
  context: Awaited<ReturnType<typeof loadPatientWorkflowContextById>>
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

function getCanonicalPatientAudioTranscriptEvents(
  events: VoiceLiveEvent[],
  transcriptText: string
) {
  const userTranscriptEvent = events.findLast(
    (event) => event.type === "user_transcript"
  );
  const errorEvents = events.filter((event) => event.type === "error");

  return [
    ...(userTranscriptEvent
      ? [
          {
            ...userTranscriptEvent,
            text: transcriptText
          }
        ]
      : []),
    ...errorEvents
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

import type {
  VoiceLiveEvent,
  VoiceAudioInput,
  VoiceAudioTurnResult,
  VoiceProvider,
  VoiceSession,
  VoiceSessionStartInput,
  VoiceTurnInput,
  VoiceTurnResult
} from "@/lib/voice/types";

const globalAny = globalThis as any;
const sessions = globalAny.localVoiceSessions || new Set<number>();
globalAny.localVoiceSessions = sessions;

const eventsBySession = globalAny.localVoiceEvents || new Map<number, VoiceLiveEvent[]>();
globalAny.localVoiceEvents = eventsBySession;

export class LocalVoiceProvider implements VoiceProvider {
  async createSession(input: VoiceSessionStartInput): Promise<VoiceSession> {
    sessions.add(input.sessionId);
    eventsBySession.set(input.sessionId, []);

    return {
      sessionId: input.sessionId,
      provider: "local-fallback",
      openedAt: new Date().toISOString()
    };
  }

  async sendUserTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    const events: VoiceLiveEvent[] = [
      {
        sessionId: input.sessionId,
        provider: "local-fallback",
        type: "user_transcript",
        text: input.userText,
        createdAt: new Date().toISOString()
      },
      {
        sessionId: input.sessionId,
        provider: "local-fallback",
        type: "model_transcript",
        text: input.requiredReply,
        createdAt: new Date().toISOString()
      }
    ];

    eventsBySession.get(input.sessionId)?.push(...events);

    return {
      replyText: input.requiredReply,
      events
    };
  }

  async sendAudioChunk(_input: VoiceAudioInput): Promise<void> {
    return undefined;
  }

  async endAudioTurn(sessionId: number): Promise<VoiceAudioTurnResult> {
    const event: VoiceLiveEvent = {
      sessionId,
      provider: "local-fallback",
      type: "error",
      text: "Browser audio capture is active, but Gemini Live is disabled. Use text input or enable Gemini Live to transcribe microphone audio.",
      raw: "Gemini Live disabled",
      createdAt: new Date().toISOString()
    };

    eventsBySession.get(sessionId)?.push(event);

    return {
      events: [event]
    };
  }

  async getEvents(sessionId: number): Promise<VoiceLiveEvent[]> {
    return eventsBySession.get(sessionId) ?? [];
  }

  async closeSession(sessionId: number): Promise<VoiceLiveEvent[]> {
    if (!sessions.has(sessionId)) {
      return [];
    }

    sessions.delete(sessionId);
    eventsBySession.delete(sessionId);

    return [
      {
        sessionId,
        provider: "local-fallback",
        type: "session_closed",
        createdAt: new Date().toISOString()
      }
    ];
  }
}

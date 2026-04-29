import type {
  VoiceLiveEvent,
  VoiceAudioInput,
  VoiceProvider,
  VoiceSession,
  VoiceSessionStartInput,
  VoiceTurnInput,
  VoiceTurnResult
} from "@/lib/voice/types";

const sessions = new Set<number>();
const eventsBySession = new Map<number, VoiceLiveEvent[]>();

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
        text: input.deterministicReply,
        createdAt: new Date().toISOString()
      }
    ];

    eventsBySession.get(input.sessionId)?.push(...events);

    return {
      replyText: input.deterministicReply,
      events
    };
  }

  async sendAudioChunk(_input: VoiceAudioInput): Promise<void> {
    return undefined;
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

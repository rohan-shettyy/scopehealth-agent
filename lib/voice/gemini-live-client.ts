import { getGeminiLiveConfig, type GeminiLiveConfig } from "@/lib/voice/config";
import type {
  VoiceLiveEvent,
  VoiceAudioInput,
  VoiceProvider,
  VoiceSession,
  VoiceSessionStartInput,
  VoiceTurnInput,
  VoiceTurnResult
} from "@/lib/voice/types";

interface LiveConnection {
  socket: WebSocket;
  session: VoiceSession;
  events: VoiceLiveEvent[];
}

const connections = new Map<number, LiveConnection>();
const TURN_TIMEOUT_MS = 8000;

export class GeminiLiveClient implements VoiceProvider {
  private readonly config: GeminiLiveConfig;

  constructor(config = getGeminiLiveConfig()) {
    this.config = config;
  }

  async createSession(input: VoiceSessionStartInput): Promise<VoiceSession> {
    if (!this.config.enabled) {
      throw new Error("Gemini Live is disabled");
    }

    if (!this.config.apiKey) {
      throw new Error("GEMINI_API_KEY is required when Gemini Live is enabled");
    }

    const socket = new WebSocket(
      `${this.config.endpoint}?key=${encodeURIComponent(this.config.apiKey)}`
    );
    const session: VoiceSession = {
      sessionId: input.sessionId,
      provider: "gemini-live",
      model: this.config.model,
      openedAt: new Date().toISOString()
    };
    const connection: LiveConnection = {
      socket,
      session,
      events: []
    };

    connections.set(input.sessionId, connection);

    await waitForOpen(socket);
    socket.addEventListener("message", (message) => {
      connection.events.push(
        ...parseGeminiServerMessage(input.sessionId, message.data)
      );
    });
    socket.addEventListener("error", () => {
      connection.events.push(
        createEvent(input.sessionId, "error", {
          raw: "Gemini Live WebSocket error"
        })
      );
    });
    socket.addEventListener("close", () => {
      connection.events.push(createEvent(input.sessionId, "session_closed"));
    });

    socket.send(
      JSON.stringify({
        setup: {
          model: `models/${this.config.model}`,
          generationConfig: {
            responseModalities: ["TEXT"],
            temperature: 0.4
          },
          systemInstruction: {
            parts: [{ text: input.systemInstruction }]
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      })
    );

    await waitForSetupComplete(connection);
    connection.events.push(createEvent(input.sessionId, "session_opened"));

    return session;
  }

  async sendUserTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    const connection = connections.get(input.sessionId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not open");
    }

    const eventStart = connection.events.length;

    connection.socket.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: buildTurnPrompt(input)
                }
              ]
            }
          ],
          turnComplete: true
        }
      })
    );

    await waitForTurnComplete(connection, eventStart);

    const events = connection.events.slice(eventStart);
    const modelText = events
      .filter((event) => event.type === "model_text" && event.text)
      .map((event) => event.text)
      .join(" ")
      .trim();

    return {
      replyText: modelText || input.deterministicReply,
      events
    };
  }

  async sendAudioChunk(input: VoiceAudioInput): Promise<void> {
    const connection = connections.get(input.sessionId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not open");
    }

    connection.socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: input.audioBase64,
            mimeType: input.mimeType
          }
        }
      })
    );
  }

  async getEvents(sessionId: number): Promise<VoiceLiveEvent[]> {
    return connections.get(sessionId)?.events ?? [];
  }

  async closeSession(sessionId: number): Promise<VoiceLiveEvent[]> {
    const connection = connections.get(sessionId);

    if (!connection) {
      return [];
    }

    connections.delete(sessionId);

    if (
      connection.socket.readyState === WebSocket.OPEN ||
      connection.socket.readyState === WebSocket.CONNECTING
    ) {
      connection.socket.close();
    }

    const event = createEvent(sessionId, "session_closed");
    connection.events.push(event);

    return [event];
  }
}

function buildTurnPrompt(input: VoiceTurnInput): string {
  return [
    "The deterministic refill workflow has already decided the next agent reply.",
    "Rewrite it naturally for a brief phone conversation.",
    "Do not ask for information beyond this reply.",
    "Do not decide workflow state or mention tools.",
    `Patient said: ${input.userText}`,
    `Required reply meaning: ${input.deterministicReply}`
  ].join("\n");
}

function parseGeminiServerMessage(
  sessionId: number,
  data: unknown
): VoiceLiveEvent[] {
  let raw: any;

  try {
    raw =
      typeof data === "string"
        ? JSON.parse(data)
        : JSON.parse(Buffer.from(data as ArrayBuffer).toString("utf8"));
  } catch (error) {
    return [
      createEvent(sessionId, "error", {
        raw: error instanceof Error ? error.message : "Unable to parse event"
      })
    ];
  }

  const events: VoiceLiveEvent[] = [];

  if (raw.setupComplete) {
    events.push(createEvent(sessionId, "setup_complete", { raw }));
  }

  if (raw.toolCall?.functionCalls) {
    events.push(
      createEvent(sessionId, "tool_call", {
        toolCalls: raw.toolCall.functionCalls,
        raw
      })
    );
  }

  if (raw.toolCallCancellation) {
    events.push(createEvent(sessionId, "tool_call_cancellation", { raw }));
  }

  const serverContent = raw.serverContent;

  if (serverContent?.inputTranscription?.text) {
    events.push(
      createEvent(sessionId, "user_transcript", {
        text: serverContent.inputTranscription.text,
        raw
      })
    );
  }

  if (serverContent?.outputTranscription?.text) {
    events.push(
      createEvent(sessionId, "model_transcript", {
        text: serverContent.outputTranscription.text,
        raw
      })
    );
  }

  const parts = serverContent?.modelTurn?.parts ?? [];

  if (serverContent?.generationComplete) {
    events.push(createEvent(sessionId, "generation_complete", { raw }));
  }

  if (serverContent?.interrupted) {
    events.push(createEvent(sessionId, "interrupted", { raw }));
  }

  if (serverContent?.turnComplete) {
    events.push(createEvent(sessionId, "turn_complete", { raw }));
  }

  for (const part of parts) {
    if (part.text) {
      events.push(
        createEvent(sessionId, "model_text", {
          text: part.text,
          raw
        })
      );
    }

    if (part.inlineData?.data) {
      events.push(
        createEvent(sessionId, "model_audio", {
          audioBase64: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
          raw
        })
      );
    }
  }

  if (raw.goAway || raw.sessionResumptionUpdate || raw.usageMetadata) {
    events.push(createEvent(sessionId, "model_text", { raw }));
  }

  return events;
}

function createEvent(
  sessionId: number,
  type: VoiceLiveEvent["type"],
  details: Partial<VoiceLiveEvent> = {}
): VoiceLiveEvent {
  return {
    sessionId,
    provider: "gemini-live",
    type,
    createdAt: new Date().toISOString(),
    ...details
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Unable to open Gemini Live WebSocket")),
      { once: true }
    );
  });
}

async function waitForSetupComplete(connection: LiveConnection) {
  await waitForEvent(connection, (event) => event.type === "setup_complete");
}

async function waitForTurnComplete(
  connection: LiveConnection,
  eventStart: number
) {
  await waitForEvent(
    connection,
    (event) => event.type === "turn_complete",
    eventStart
  );
}

function waitForEvent(
  connection: LiveConnection,
  predicate: (event: VoiceLiveEvent, raw?: any) => boolean,
  eventStart = 0
): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (const event of connection.events.slice(eventStart)) {
        if (predicate(event, event.raw)) {
          clearInterval(interval);
          resolve();
          return;
        }
      }

      if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for Gemini Live response"));
      }
    }, 25);
  });
}

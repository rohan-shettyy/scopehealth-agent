import { getGeminiLiveConfig, type GeminiLiveConfig } from "@/lib/voice/config";
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

interface LiveConnection {
  socket: WebSocket;
  session: VoiceSession;
  events: VoiceLiveEvent[];
  acceptingAudio: boolean;
  systemInstruction: string;
}

const globalStore = globalThis as typeof globalThis & {
  geminiConnections?: Map<number, LiveConnection>;
};
const connections =
  globalStore.geminiConnections ?? new Map<number, LiveConnection>();
globalStore.geminiConnections = connections;
const TURN_TIMEOUT_MS = 15000;

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
      events: [],
      acceptingAudio: true,
      systemInstruction: input.systemInstruction
    };

    connections.set(input.sessionId, connection);

    await waitForOpen(socket);
    bindSocketEvents(connection);
    sendSetup(connection, input.systemInstruction);


    await waitForSetupComplete(connection);
    connection.events.push(createEvent(input.sessionId, "session_opened"));

    return session;
  }

  async sendUserTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
    const connection = connections.get(input.sessionId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not open");
    }

    // Send text turn on the SAME Live WebSocket (no second connection = no 409).
    // The session is configured with responseModalities: ["AUDIO"], so
    // Gemini will respond with spoken audio + output transcription.
    const eventStart = connection.events.length;

    connection.socket.send(
      JSON.stringify({
        realtimeInput: {
          text: buildTurnPrompt(input)
        }
      })
    );

    await waitForTurnComplete(connection, eventStart);

    const events = connection.events.slice(eventStart);

    // Extract text from output transcription (what the model spoke)
    const modelTranscript = events
      .filter((event) => event.type === "model_transcript" && event.text)
      .map((event) => event.text)
      .join(" ")
      .trim();

    // Also check model_text events as fallback
    const modelText = modelTranscript || events
      .filter((event) => event.type === "model_text" && event.text)
      .map((event) => event.text)
      .join(" ")
      .trim();

    return {
      replyText: input.requiredReply,
      events: replaceModelTranscriptEvents(
        input.sessionId,
        events,
        input.requiredReply
      )
    };
  }

  async sendAudioChunk(input: VoiceAudioInput): Promise<void> {
    const connection = connections.get(input.sessionId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not open");
    }

    if (!connection.acceptingAudio) {
      return;
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

  async endAudioTurn(sessionId: number): Promise<VoiceAudioTurnResult> {
    const connection = connections.get(sessionId);

    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not open");
    }

    connection.acceptingAudio = false;
    const eventStart = connection.events.length;

    connection.socket.send(
      JSON.stringify({
        realtimeInput: {
          audioStreamEnd: true
        }
      })
    );

    await waitForAudioTranscriptionOrTimeout(connection, eventStart);

    const events = connection.events.slice(eventStart);
    const transcriptText = getLatestUserTranscript(events);

    connection.acceptingAudio = true;

    return {
      transcriptText: transcriptText || undefined,
      events
    };
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

function getLatestUserTranscript(events: VoiceLiveEvent[]) {
  return events
    .filter((event) => event.type === "user_transcript" && event.text?.trim())
    .at(-1)
    ?.text
    ?.trim();
}

function bindSocketEvents(connection: LiveConnection) {
  connection.socket.addEventListener("message", async (message) => {
    connection.events.push(
      ...parseGeminiServerMessage(
        connection.session.sessionId,
        await decodeWebSocketData(message.data)
      )
    );
  });
  connection.socket.addEventListener("error", () => {
    connection.events.push(
      createEvent(connection.session.sessionId, "error", {
        raw: "Gemini Live WebSocket error"
      })
    );
  });
  connection.socket.addEventListener("close", (event) => {
    connection.events.push(
      createEvent(connection.session.sessionId, "session_closed", {
        text: event.reason
          ? `Gemini Live WebSocket closed: ${event.code} ${event.reason}`
          : `Gemini Live WebSocket closed: ${event.code}`
      })
    );
  });
}

function sendSetup(connection: LiveConnection, systemInstruction: string) {
  connection.socket.send(
    JSON.stringify({
      setup: {
        model: `models/${connection.session.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.4,
          speechConfig: {
            languageCode: "en-US",
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede"
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    })
  );
}

function buildTurnPrompt(input: VoiceTurnInput): string {
  return [
    input.instructionPrompt,
    "",
    "Final spoken line:",
    input.requiredReply,
    "",
    "Speak the final spoken line exactly. Do not add, omit, translate, localize, or replace workflow details.",
    "The caller is speaking English. Keep all transcript and audio output in English."
  ].join("\n");
}

function replaceModelTranscriptEvents(
  sessionId: number,
  events: VoiceLiveEvent[],
  spokenText: string
): VoiceLiveEvent[] {
  return [
    ...events.filter((event) => event.type !== "model_transcript"),
    createEvent(sessionId, "model_transcript", {
      text: spokenText
    })
  ];
}

function normalizeEnglishTranscript(text: string): string | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return undefined;
  }

  // Live sometimes emits captions in another script for short utterances.
  // The demo is English-only, so suppress those captions instead of showing
  // confusing non-English text while preserving the audio turn itself.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function parseGeminiServerMessage(
  sessionId: number,
  data: string
): VoiceLiveEvent[] {
  let raw: any;

  try {
    raw = JSON.parse(data);
  } catch (error) {
    return [
      createEvent(sessionId, "error", {
        raw: error instanceof Error ? error.message : "Unable to parse event"
      })
    ];
  }

  const events: VoiceLiveEvent[] = [];

  if (raw.error) {
    events.push(
      createEvent(sessionId, "error", {
        text: raw.error.message ?? "Gemini Live returned an error",
        raw
      })
    );
  }

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
    const text = normalizeEnglishTranscript(serverContent.inputTranscription.text);

    if (text) {
      events.push(
        createEvent(sessionId, "user_transcript", {
          text,
          raw
        })
      );
    }
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

async function decodeWebSocketData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Blob) {
    return data.text();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer).toString("utf8");
  }

  return String(data);
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

async function waitForAudioTranscriptionOrTimeout(
  connection: LiveConnection,
  eventStart: number
) {
  try {
    await waitForEvent(
      connection,
      (event) => event.type === "turn_complete",
      eventStart,
      TURN_TIMEOUT_MS
    );
  } catch {
    return undefined;
  }
}

function waitForEvent(
  connection: LiveConnection,
  predicate: (event: VoiceLiveEvent, raw?: any) => boolean,
  eventStart = 0,
  timeoutMs = TURN_TIMEOUT_MS
): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (const event of connection.events.slice(eventStart)) {
        if (event.type === "error") {
          clearInterval(interval);
          reject(new Error(event.text ?? "Gemini Live returned an error"));
          return;
        }

        if (event.type === "session_closed") {
          clearInterval(interval);
          reject(new Error(event.text ?? "Gemini Live WebSocket closed"));
          return;
        }

        if (predicate(event, event.raw)) {
          clearInterval(interval);
          resolve();
          return;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for Gemini Live response"));
      }
    }, 25);
  });
}

export type VoiceProviderName = "gemini-live" | "local-fallback";

export type VoiceLiveEventType =
  | "session_opened"
  | "session_closed"
  | "user_transcript"
  | "model_transcript"
  | "model_text"
  | "model_audio"
  | "tool_call"
  | "tool_call_cancellation"
  | "turn_complete"
  | "generation_complete"
  | "interrupted"
  | "setup_complete"
  | "error";

export interface VoiceLiveEvent {
  type: VoiceLiveEventType;
  sessionId: number;
  provider: VoiceProviderName;
  text?: string;
  audioBase64?: string;
  mimeType?: string;
  toolCalls?: unknown[];
  raw?: unknown;
  createdAt: string;
}

export interface VoiceSession {
  sessionId: number;
  provider: VoiceProviderName;
  model?: string;
  openedAt: string;
}

export interface VoiceSessionStartInput {
  sessionId: number;
  systemInstruction: string;
}

export interface VoiceTurnInput {
  sessionId: number;
  userText: string;
  deterministicReply: string;
}

export interface VoiceAudioInput {
  sessionId: number;
  audioBase64: string;
  mimeType: string;
}

export interface VoiceTurnResult {
  replyText: string;
  events: VoiceLiveEvent[];
}

export interface VoiceProvider {
  createSession(input: VoiceSessionStartInput): Promise<VoiceSession>;
  sendUserTurn(input: VoiceTurnInput): Promise<VoiceTurnResult>;
  sendAudioChunk(input: VoiceAudioInput): Promise<void>;
  getEvents(sessionId: number): Promise<VoiceLiveEvent[]>;
  closeSession(sessionId: number): Promise<VoiceLiveEvent[]>;
}

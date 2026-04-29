export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export interface GeminiLiveConfig {
  apiKey?: string;
  model: string;
  enabled: boolean;
  endpoint: string;
}

export function getGeminiLiveConfig(): GeminiLiveConfig {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL ?? GEMINI_LIVE_DEFAULT_MODEL,
    enabled: process.env.ENABLE_GEMINI_LIVE === "true",
    endpoint:
      process.env.GEMINI_LIVE_WS_ENDPOINT ??
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
  };
}

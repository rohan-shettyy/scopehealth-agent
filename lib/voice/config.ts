export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export interface GeminiLiveConfig {
  apiKey?: string;
  model: string;
  textModel: string;
  enabled: boolean;
  endpoint: string;
}

export const GEMINI_TEXT_DEFAULT_MODEL = "gemini-2.5-flash";

export function getGeminiLiveConfig(): GeminiLiveConfig {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL ?? GEMINI_LIVE_DEFAULT_MODEL,
    textModel: process.env.GEMINI_TEXT_MODEL ?? GEMINI_TEXT_DEFAULT_MODEL,
    enabled: ["true", "t", "1", "yes"].includes(
      (process.env.ENABLE_GEMINI_LIVE ?? "").toLowerCase()
    ),
    endpoint:
      process.env.GEMINI_LIVE_WS_ENDPOINT ??
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
  };
}

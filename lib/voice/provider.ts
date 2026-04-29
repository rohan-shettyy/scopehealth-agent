import { getGeminiLiveConfig } from "@/lib/voice/config";
import { GeminiLiveClient } from "@/lib/voice/gemini-live-client";
import { LocalVoiceProvider } from "@/lib/voice/local-voice-provider";
import type { VoiceProvider } from "@/lib/voice/types";

const localProvider = new LocalVoiceProvider();
let geminiProvider: GeminiLiveClient | undefined;

export function getCallVoiceProvider(): VoiceProvider {
  const config = getGeminiLiveConfig();

  if (!config.enabled) {
    return localProvider;
  }

  if (!config.apiKey) {
    return localProvider;
  }

  geminiProvider ??= new GeminiLiveClient(config);

  return geminiProvider;
}

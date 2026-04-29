import { getGeminiLiveConfig } from "@/lib/voice/config";
import { GeminiLiveClient } from "@/lib/voice/gemini-live-client";
import { LocalVoiceProvider } from "@/lib/voice/local-voice-provider";
import type { VoiceProvider } from "@/lib/voice/types";

const localProvider = new LocalVoiceProvider();
const globalAny = globalThis as any;

export function getCallVoiceProvider(): VoiceProvider {
  const config = getGeminiLiveConfig();

  if (!config.enabled) {
    return localProvider;
  }

  if (!config.apiKey) {
    return localProvider;
  }

  globalAny.geminiProvider ??= new GeminiLiveClient(config);

  return globalAny.geminiProvider;
}

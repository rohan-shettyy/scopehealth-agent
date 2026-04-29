/**
 * Uses the standard Gemini REST API (generateContent) for text rephrasing.
 * This avoids opening a second WebSocket which causes 409 conflicts
 * with the active Gemini Live audio session.
 */

import { getGeminiLiveConfig } from "@/lib/voice/config";

const GENERATE_CONTENT_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

export async function rephraseWithGemini(
  systemInstruction: string,
  userText: string,
  requiredReply: string,
  instructionPrompt?: string
): Promise<string> {
  const config = getGeminiLiveConfig();

  if (!config.apiKey) {
    return requiredReply;
  }

  const model = config.textModel;
  const url = `${GENERATE_CONTENT_BASE}/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              instructionPrompt ??
                [
                  "Gemini structured orchestration has already selected the next agent reply.",
                  "Rewrite it naturally for a brief phone conversation.",
                  "Do not ask for information beyond this reply.",
                  "Do not decide workflow state or mention tools.",
                  `Patient said: ${userText}`,
                  `Required reply meaning: ${requiredReply}`
                ].join("\n")
            ].join("\n")
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 256
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error(
        `Gemini generateContent failed: ${response.status} ${response.statusText}`
      );
      return requiredReply;
    }

    const json = await response.json();
    const text =
      json?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text)
        ?.join(" ")
        ?.trim() ?? "";

    return text || requiredReply;
  } catch (error) {
    console.error("Gemini generateContent error:", error);
    return requiredReply;
  }
}

export async function generateTextWithGemini(
  systemInstruction: string,
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  } = {}
): Promise<string | undefined> {
  const config = getGeminiLiveConfig();

  if (!config.apiKey) {
    return undefined;
  }

  const model = options.model ?? config.textModel;
  const url = `${GENERATE_CONTENT_BASE}/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 512
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error(
        `Gemini generateContent failed: ${response.status} ${response.statusText}`
      );
      return undefined;
    }

    const json = await response.json();
    const text =
      json?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text)
        ?.join(" ")
        ?.trim() ?? "";

    return text || undefined;
  } catch (error) {
    console.error("Gemini generateContent error:", error);
    return undefined;
  }
}

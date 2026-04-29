import { NextResponse } from "next/server";

import { streamCallAudioChunk } from "@/lib/refill-session-service";
import { jsonError, requireNumber, requireString } from "@/lib/route-errors";

// POST /api/workflow/call/audio
// Body: { "sessionId": number, "audioBase64": string, "mimeType": "audio/pcm;rate=16000" }
// Response: { voiceEvents }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await streamCallAudioChunk({
        sessionId: requireNumber(body.sessionId, "sessionId"),
        audioBase64: requireString(body.audioBase64, "audioBase64"),
        mimeType: requireString(body.mimeType, "mimeType")
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}

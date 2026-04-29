import { NextResponse } from "next/server";

import { finishCallAudioTurn } from "@/lib/refill-session-service";
import { jsonError, requireNumber } from "@/lib/route-errors";

// POST /api/workflow/call/audio/end
// Body: { "sessionId": number }
// Response: { session, agentReply, isComplete, refillRequest?, voiceEvents? }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await finishCallAudioTurn(requireNumber(body.sessionId, "sessionId"))
    );
  } catch (error) {
    return jsonError(error);
  }
}

import { NextResponse } from "next/server";

import { submitCallInput } from "@/lib/refill-session-service";
import { jsonError, requireNumber, requireString } from "@/lib/route-errors";

// POST /api/workflow/call/input
// Body: { "sessionId": number, "text": string }
// Response: { session, agentReply, isComplete, refillRequest? }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await submitCallInput(
        requireNumber(body.sessionId, "sessionId"),
        requireString(body.text, "text")
      )
    );
  } catch (error) {
    return jsonError(error);
  }
}

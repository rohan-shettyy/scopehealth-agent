import { NextResponse } from "next/server";

import { submitSmsReply } from "@/lib/refill-session-service";
import { jsonError, requireNumber, requireString } from "@/lib/route-errors";

// POST /api/workflow/sms/reply
// Body: { "sessionId": number, "text": string }
// Response: { session, agentReply, isComplete, refillRequest? }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await submitSmsReply(
        requireNumber(body.sessionId, "sessionId"),
        requireString(body.text, "text")
      )
    );
  } catch (error) {
    return jsonError(error);
  }
}

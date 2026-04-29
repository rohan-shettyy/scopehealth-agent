import { NextResponse } from "next/server";

import { hangUpCall } from "@/lib/refill-session-service";
import { jsonError, requireNumber } from "@/lib/route-errors";

// POST /api/workflow/call/hangup
// Body: { "sessionId": number }
// Response: { session, messages, refillRequest? }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await hangUpCall(requireNumber(body.sessionId, "sessionId"))
    );
  } catch (error) {
    return jsonError(error);
  }
}

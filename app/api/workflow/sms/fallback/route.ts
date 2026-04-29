import { NextResponse } from "next/server";

import { triggerSmsFallback } from "@/lib/refill-session-service";
import { jsonError, requireNumber } from "@/lib/route-errors";

// POST /api/workflow/sms/fallback
// Body: { "sessionId": number }
// Response: { session, messages, refillRequest? }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await triggerSmsFallback(requireNumber(body.sessionId, "sessionId"))
    );
  } catch (error) {
    return jsonError(error);
  }
}

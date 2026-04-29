import { NextResponse } from "next/server";

import { resetSimulatedCall } from "@/lib/refill-session-service";
import { jsonError, requireNumber } from "@/lib/route-errors";

// POST /api/workflow/call/reset
// Body: { "sessionId": number }
// Response: { reset: true }
export async function POST(request: Request) {
  try {
    const body = await request.json();

    return NextResponse.json(
      await resetSimulatedCall(requireNumber(body.sessionId, "sessionId"))
    );
  } catch (error) {
    return jsonError(error);
  }
}

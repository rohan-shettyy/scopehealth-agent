import { NextResponse } from "next/server";

import { startSimulatedCall } from "@/lib/refill-session-service";
import { jsonError } from "@/lib/route-errors";

// POST /api/workflow/call/start
// Response: { session, messages, refillRequest? }
export async function POST() {
  try {
    return NextResponse.json(await startSimulatedCall());
  } catch (error) {
    return jsonError(error);
  }
}

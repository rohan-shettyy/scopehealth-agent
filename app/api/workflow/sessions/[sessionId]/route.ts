import { NextResponse } from "next/server";

import { getSessionTranscript } from "@/lib/refill-session-service";
import { jsonError } from "@/lib/route-errors";

// GET /api/workflow/sessions/:sessionId
// Response: { session, messages, refillRequest? }
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;

    return NextResponse.json(await getSessionTranscript(Number(sessionId)));
  } catch (error) {
    return jsonError(error);
  }
}

import { NextResponse } from "next/server";

import { getCallVoiceEvents } from "@/lib/refill-session-service";
import { jsonError } from "@/lib/route-errors";

// GET /api/workflow/call/events/:sessionId
// Response: { voiceEvents }
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;

    return NextResponse.json(await getCallVoiceEvents(Number(sessionId)));
  } catch (error) {
    return jsonError(error);
  }
}

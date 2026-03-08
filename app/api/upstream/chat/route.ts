import { NextResponse } from "next/server.js";

import { getProviderReadiness } from "@/lib/upstream/providers";
import { getUpstreamRouteHealth, handleUpstreamChatRequest } from "@/lib/upstream/handleUpstreamChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON", failure_reason: "bad_request" }, { status: 400 });
  }
  return handleUpstreamChatRequest({ req, body });
}

export async function GET() {
  const readiness = getProviderReadiness();
  const health = getUpstreamRouteHealth();
  return NextResponse.json({
    ok: true,
    message:
      "POST machine-readable JSON to this endpoint. Example: { query, prompt_template_id, required_structured_keys?, intent_hint?, prompt_hash?, parent_trace_id?, parent_request_id?, llm_provider?, llm_model? }",
    ...readiness,
    ...health,
  });
}

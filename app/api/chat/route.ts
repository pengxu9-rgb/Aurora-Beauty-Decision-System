import { NextResponse } from "next/server.js";

import { handlePublicChatRequest } from "@/lib/publicChatFacade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePublicChatRequest(req);
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message:
      "POST public chat JSON to this endpoint. Public /api/chat now acts as a facade/proxy. Machine callers should use /api/upstream/chat.",
  });
}

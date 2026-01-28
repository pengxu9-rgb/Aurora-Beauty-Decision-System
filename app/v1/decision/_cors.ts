import { NextResponse } from "next/server";

export function getCorsHeaders() {
  const origin = process.env.AURORA_CORS_ORIGIN?.trim() || "*";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  } as const;
}

export function withCors(res: NextResponse) {
  const headers = getCorsHeaders();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export function corsPreflight() {
  return withCors(new NextResponse(null, { status: 204 }));
}


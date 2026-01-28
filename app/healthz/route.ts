import { NextResponse } from "next/server";

export function GET() {
  const origin = process.env.AURORA_CORS_ORIGIN?.trim() || "*";
  return NextResponse.json(
    {
      ok: true,
      service: "aurora-decision-service",
      version: "v4.0",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}

export function OPTIONS() {
  const origin = process.env.AURORA_CORS_ORIGIN?.trim() || "*";
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

import { NextResponse } from "next/server";

import { buildEnvStressApiResponse } from "@/lib/env-stress";

import { corsPreflight, withCors } from "../_cors";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  const { status, json } = buildEnvStressApiResponse(body);
  return withCors(NextResponse.json(json, { status }));
}

export function OPTIONS() {
  return corsPreflight();
}


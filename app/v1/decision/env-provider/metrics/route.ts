import { NextResponse } from "next/server";

import { getEnvProviderMetricsV1 } from "@/lib/env-provider";

import { corsPreflight, withCors } from "../../_cors";

export function GET() {
  return withCors(NextResponse.json(getEnvProviderMetricsV1()));
}

export function OPTIONS() {
  return corsPreflight();
}


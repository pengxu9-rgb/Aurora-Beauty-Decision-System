import { NextResponse } from "next/server";

import { getEnvSnapshotV1 } from "@/lib/env-provider";

import { corsPreflight, withCors } from "../_cors";

type EnvSnapshotRequest = {
  lat: number;
  lon: number;
  units?: "metric";
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function POST(req: Request) {
  let body: EnvSnapshotRequest;
  try {
    body = (await req.json()) as EnvSnapshotRequest;
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  if (!isFiniteNumber(body?.lat) || !isFiniteNumber(body?.lon)) {
    return withCors(NextResponse.json({ error: "`lat` and `lon` must be numbers" }, { status: 400 }));
  }

  if (body.lat < -90 || body.lat > 90 || body.lon < -180 || body.lon > 180) {
    return withCors(NextResponse.json({ error: "`lat`/`lon` out of range" }, { status: 400 }));
  }

  const units = body.units === "metric" ? "metric" : "metric";
  const res = await getEnvSnapshotV1({ lat: body.lat, lon: body.lon, units });

  if (!res.ok || !res.snapshot) {
    return withCors(
      NextResponse.json(
        {
          error: "EnvSnapshot unavailable",
          provider_error_code: res.provider_error_code ?? null,
          missing_inputs: res.missing_inputs ?? [],
        },
        { status: 503 },
      ),
    );
  }

  return withCors(NextResponse.json(res.snapshot));
}

export function OPTIONS() {
  return corsPreflight();
}


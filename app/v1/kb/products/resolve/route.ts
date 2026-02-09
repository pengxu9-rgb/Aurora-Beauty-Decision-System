import { NextResponse } from "next/server";

import { resolveAuroraProductId } from "@/lib/product-id-resolver";

import { corsPreflight, withCors } from "../../../decision/_cors";

function pickFirst(...values: Array<string | null>) {
  for (const value of values) {
    const v = String(value ?? "").trim();
    if (v) return v;
  }
  return "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const value = pickFirst(
    url.searchParams.get("value"),
    url.searchParams.get("ref"),
    url.searchParams.get("id"),
    url.searchParams.get("product_ref"),
    url.searchParams.get("product_id"),
  );

  if (!value) {
    return withCors(NextResponse.json({ ok: false, error: "`value` (or `ref`) is required" }, { status: 400 }));
  }

  const sourceSystem = url.searchParams.get("source_system");
  const sourceType = url.searchParams.get("source_type");

  const resolved = await resolveAuroraProductId({
    value,
    sourceSystem,
    sourceType,
  });

  if (!resolved) {
    return withCors(
      NextResponse.json(
        {
          ok: false,
          error: "No Aurora product mapping found",
          value,
          source_system: sourceSystem || null,
          source_type: sourceType || null,
        },
        { status: 404 },
      ),
    );
  }

  return withCors(
    NextResponse.json({
      ok: true,
      value,
      requested_source_system: sourceSystem || null,
      requested_source_type: sourceType || null,
      ...resolved,
    }),
  );
}

export function OPTIONS() {
  return corsPreflight();
}

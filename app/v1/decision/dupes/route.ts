import { NextResponse } from "next/server";

import { findDupes } from "@/lib/engine";
import type { SkuVector } from "@/types";

import { corsPreflight, withCors } from "../_cors";
import { getSkuById, getSkuDatabase } from "../_lib";

type DupesRequest = {
  anchor_sku_id: string;
  limit?: number;
  prefer_brand?: string;
};

function filterDupeDatabase(anchor: SkuVector, db: SkuVector[]) {
  if (anchor.category === "serum" || anchor.category === "treatment") {
    return db.filter((s) => s.category === "serum" || s.category === "treatment");
  }
  return db;
}

export async function POST(req: Request) {
  let body: DupesRequest;
  try {
    body = (await req.json()) as DupesRequest;
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  if (!body?.anchor_sku_id) {
    return withCors(NextResponse.json({ error: "`anchor_sku_id` is required" }, { status: 400 }));
  }

  const anchor = getSkuById(body.anchor_sku_id);
  if (!anchor) return withCors(NextResponse.json({ error: "Anchor SKU not found" }, { status: 404 }));

  const db = filterDupeDatabase(anchor, getSkuDatabase());
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(20, body.limit) : 6;
  const dupes = findDupes(anchor, db, limit);

  const preferBrand = (body.prefer_brand ?? "The Ordinary").trim();
  const recommended = dupes.find((d) => d.sku.brand === preferBrand) ?? dupes[0] ?? null;

  return withCors(
    NextResponse.json({
      anchor_sku_id: anchor.sku_id,
      prefer_brand: preferBrand,
      recommended_dupe: recommended,
      dupes,
    }),
  );
}

export function OPTIONS() {
  return corsPreflight();
}

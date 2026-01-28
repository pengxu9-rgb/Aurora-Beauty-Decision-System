import { NextResponse } from "next/server";

import { calculateScore, findDupes } from "@/lib/engine";
import type { DupeMatch, SkuScoreBreakdown, SkuVector, UserVector } from "@/types";

import { corsPreflight, withCors } from "../_cors";
import { getSkuById, getSkuDatabase } from "../_lib";

type AnalyzeRequest = {
  anchor_sku_id: string;
  user: UserVector;
  dupe_limit?: number;
  prefer_brand?: string;
};

type AnalyzeResponse = {
  anchor: SkuVector;
  anchor_score: SkuScoreBreakdown;
  dupes: DupeMatch[];
  recommended_dupe: DupeMatch | null;
};

function filterDupeDatabase(anchor: SkuVector, db: SkuVector[]) {
  if (anchor.category === "serum" || anchor.category === "treatment") {
    return db.filter((s) => s.category === "serum" || s.category === "treatment");
  }
  return db;
}

export async function POST(req: Request) {
  let body: AnalyzeRequest;
  try {
    body = (await req.json()) as AnalyzeRequest;
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  if (!body?.anchor_sku_id || !body?.user) {
    return withCors(NextResponse.json({ error: "`anchor_sku_id` and `user` are required" }, { status: 400 }));
  }

  const anchor = await getSkuById(body.anchor_sku_id);
  if (!anchor) return withCors(NextResponse.json({ error: "Anchor SKU not found" }, { status: 404 }));

  const anchor_score = calculateScore(anchor, body.user);

  const db = filterDupeDatabase(anchor, await getSkuDatabase());
  const dupeLimit = typeof body.dupe_limit === "number" && body.dupe_limit > 0 ? Math.min(20, body.dupe_limit) : 6;
  const dupes = findDupes(anchor, db, dupeLimit);

  const preferBrand = (body.prefer_brand ?? "The Ordinary").trim();
  const recommended_dupe = dupes.find((d) => d.sku.brand === preferBrand) ?? dupes[0] ?? null;

  const res: AnalyzeResponse = { anchor, anchor_score, dupes, recommended_dupe };
  return withCors(NextResponse.json(res));
}

export function OPTIONS() {
  return corsPreflight();
}

import { NextResponse } from "next/server";

import { searchIngredientResearchV1 } from "@/lib/ingredient-research-kb";

import { corsPreflight, withCors } from "../../../decision/_cors";

function parseLimit(v: string | null): number {
  const n = v ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(50, Math.floor(n));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return withCors(NextResponse.json({ ok: false, error: "`q` is required" }, { status: 400 }));

  const limit = parseLimit(url.searchParams.get("limit"));
  const out = await searchIngredientResearchV1(q, limit);
  return withCors(NextResponse.json({ ok: true, ...out }));
}

export function OPTIONS() {
  return corsPreflight();
}

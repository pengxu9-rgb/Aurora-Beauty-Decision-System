import { NextResponse } from "next/server";

import { getIngredientResearchProfileV1 } from "@/lib/ingredient-research-kb";

import { corsPreflight, withCors } from "../../../decision/_cors";

export async function GET(_req: Request, ctx: { params: { ingredient_id: string } }) {
  const ingredientId = String(ctx?.params?.ingredient_id ?? "").trim();
  if (!ingredientId) return withCors(NextResponse.json({ ok: false, error: "`ingredient_id` is required" }, { status: 400 }));

  const out = await getIngredientResearchProfileV1(ingredientId);
  return withCors(NextResponse.json({ ok: true, ...out }));
}

export function OPTIONS() {
  return corsPreflight();
}

import { NextResponse } from "next/server";

import { getProductIngredientsByIdV1 } from "@/lib/product-ingredients-kb";

import { corsPreflight, withCors } from "../../../../decision/_cors";

export async function GET(_req: Request, ctx: { params: { product_id: string } }) {
  const productId = String(ctx?.params?.product_id ?? "").trim();
  if (!productId) return withCors(NextResponse.json({ ok: false, error: "`product_id` is required" }, { status: 400 }));

  const out = await getProductIngredientsByIdV1(productId);
  if (!out) return withCors(NextResponse.json({ ok: false, error: "Product not found" }, { status: 404 }));

  return withCors(NextResponse.json({ ok: true, ...out }));
}

export function OPTIONS() {
  return corsPreflight();
}

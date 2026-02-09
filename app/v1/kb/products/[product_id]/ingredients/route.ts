import { NextResponse } from "next/server";

import { resolveAuroraProductId } from "@/lib/product-id-resolver";
import { getProductIngredientsByIdV1 } from "@/lib/product-ingredients-kb";

import { corsPreflight, withCors } from "../../../../decision/_cors";

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(req: Request, ctx: { params: { product_id: string } }) {
  const productRef = String(ctx?.params?.product_id ?? "").trim();
  if (!productRef) return withCors(NextResponse.json({ ok: false, error: "`product_id` is required" }, { status: 400 }));

  const url = new URL(req.url);
  const sourceSystem = url.searchParams.get("source_system");
  const sourceType = url.searchParams.get("source_type");

  let resolved = null as Awaited<ReturnType<typeof resolveAuroraProductId>>;
  let productId = productRef;
  const shouldResolve = Boolean(sourceSystem || sourceType) || !looksLikeUuid(productRef);
  if (shouldResolve) {
    resolved = await resolveAuroraProductId({
      value: productRef,
      sourceSystem,
      sourceType,
    });
    if (!resolved) {
      return withCors(
        NextResponse.json(
          {
            ok: false,
            error: "No Aurora product mapping found",
            product_ref: productRef,
            source_system: sourceSystem || null,
            source_type: sourceType || null,
          },
          { status: 404 },
        ),
      );
    }
    productId = resolved.product_id;
  }

  const out = await getProductIngredientsByIdV1(productId);
  if (!out) return withCors(NextResponse.json({ ok: false, error: "Product not found" }, { status: 404 }));

  return withCors(
    NextResponse.json({
      ok: true,
      ...(resolved
        ? {
            resolved: {
              product_ref: productRef,
              product_id: resolved.product_id,
              matched_by: resolved.matched_by,
              source_system: resolved.source_system,
              source_type: resolved.source_type,
              matched_ref: resolved.matched_ref,
              confidence: resolved.confidence,
            },
          }
        : {}),
      ...out,
    }),
  );
}

export function OPTIONS() {
  return corsPreflight();
}

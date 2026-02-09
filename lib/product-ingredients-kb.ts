import "server-only";

import { prisma } from "@/lib/server/prisma";
import { canonicalizeRawIngredientText } from "@/lib/raw-ingredient-cleaning";

type ProductRawIngredientSnippetV1 = {
  source_sheet: string;
  source_ref: string | null;
  content: string;
  original_content: string | null;
  updated_at: string;
};

type ProductIngredientsPayloadV1 = {
  schema_version: "aurora.product_ingredients.v1";
  product_id: string;
  product: {
    brand: string;
    name: string;
    region_availability: string[];
  };
  ingredients: {
    full_list: string[];
    hero_actives: unknown;
    count: number;
  };
  raw_ingredient: {
    text: string | null;
    original_text: string | null;
    source_sheet: string | null;
    source_ref: string | null;
    updated_at: string | null;
  };
  raw_ingredient_candidates: ProductRawIngredientSnippetV1[];
};

function readSourceRef(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const sourceRef = (metadata as { source_ref?: unknown }).source_ref;
  if (typeof sourceRef !== "string") return null;
  const trimmed = sourceRef.trim();
  return trimmed || null;
}

function normalizeRawIngredientCandidates(
  snippets: Array<{
    sourceSheet: string;
    content: string;
    metadata: unknown;
    updatedAt: Date;
  }>
): ProductRawIngredientSnippetV1[] {
  const out: ProductRawIngredientSnippetV1[] = [];
  const seen = new Set<string>();
  for (const item of snippets) {
    const originalContent = typeof item.content === "string" ? item.content.trim() : "";
    const content = canonicalizeRawIngredientText(originalContent);
    if (!content) continue;
    const dedupKey = `${item.sourceSheet}::${content.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      source_sheet: item.sourceSheet,
      source_ref: readSourceRef(item.metadata),
      content,
      original_content: originalContent || null,
      updated_at: item.updatedAt.toISOString(),
    });
  }
  return out;
}

export async function getProductIngredientsByIdV1(productId: string): Promise<ProductIngredientsPayloadV1 | null> {
  const targetId = String(productId || "").trim();
  if (!targetId) return null;

  const row = await prisma.product.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      brand: true,
      name: true,
      regionAvailability: true,
      ingredients: {
        select: {
          fullList: true,
          heroActives: true,
        },
      },
      kbSnippets: {
        where: { field: "raw_ingredient_text" },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          sourceSheet: true,
          content: true,
          metadata: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!row) return null;

  const candidates = normalizeRawIngredientCandidates(row.kbSnippets);
  const preferred =
    candidates.find((x) => x.source_sheet === "ingredient_harvester_manual") ??
    candidates.find((x) => x.source_sheet === "ingredient_harvester") ??
    candidates[0] ??
    null;

  const fullList = Array.isArray(row.ingredients?.fullList) ? row.ingredients?.fullList.map((x) => String(x)) : [];

  return {
    schema_version: "aurora.product_ingredients.v1",
    product_id: row.id,
    product: {
      brand: row.brand,
      name: row.name,
      region_availability: row.regionAvailability ?? [],
    },
    ingredients: {
      full_list: fullList,
      hero_actives: row.ingredients?.heroActives ?? null,
      count: fullList.length,
    },
    raw_ingredient: {
      text: canonicalizeRawIngredientText(preferred?.content, fullList),
      original_text: preferred?.original_content ?? null,
      source_sheet: preferred?.source_sheet ?? null,
      source_ref: preferred?.source_ref ?? null,
      updated_at: preferred?.updated_at ?? null,
    },
    raw_ingredient_candidates: candidates,
  };
}

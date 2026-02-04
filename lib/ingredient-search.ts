import "server-only";

import { prisma } from "@/lib/server/prisma";

import { searchIngredientDocsV1 } from "./ingredient-search-core";
import type { IngredientSearchDocV1, IngredientSearchInputV1, IngredientSearchOutputV1 } from "./ingredient-search-core";

export type { IngredientSearchDocV1, IngredientSearchHitV1, IngredientSearchInputV1, IngredientSearchOutputV1 } from "./ingredient-search-core";
export { searchIngredientDocsV1 } from "./ingredient-search-core";

export async function ingredientSearchV1(input: IngredientSearchInputV1): Promise<IngredientSearchOutputV1> {
  const includeKbSnippets = Boolean(input.filters?.include_kb_snippets);
  const requestedIds = Array.isArray(input.filters?.product_ids)
    ? input.filters?.product_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];

  const products = await prisma.product.findMany({
    where: requestedIds.length ? { id: { in: requestedIds } } : undefined,
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
      kbSnippets: includeKbSnippets
        ? {
            select: {
              content: true,
            },
          }
        : undefined,
    },
    orderBy: { updatedAt: "desc" },
    take: 2000, // safety cap for MVP
  });

  const docs: IngredientSearchDocV1[] = products.map((p) => ({
    product_id: p.id,
    display_name: `${p.brand} ${p.name}`.trim(),
    region_availability: p.regionAvailability ?? [],
    ingredients_full_list: (p.ingredients?.fullList as any) ?? [],
    hero_actives: p.ingredients?.heroActives ?? null,
    kb_snippets: includeKbSnippets ? p.kbSnippets.map((s) => s.content) : null,
  }));

  return searchIngredientDocsV1(docs, input);
}

import assert from "node:assert/strict";
import test from "node:test";

import { searchIngredientDocsV1 } from "../lib/ingredient-search-core.ts";

test("ING-001: matches ingredients.full_list", () => {
  const out = searchIngredientDocsV1(
    [
      {
        product_id: "p1",
        display_name: "Brand A Serum",
        region_availability: ["GLOBAL"],
        ingredients_full_list: ["Water", "Niacinamide", "Zinc PCA"],
        hero_actives: [{ name: "Niacinamide", pct: "10%" }],
      },
      {
        product_id: "p2",
        display_name: "Brand B Cream",
        region_availability: ["GLOBAL"],
        ingredients_full_list: ["Water", "Glycerin"],
      },
    ],
    {
      schema_version: "aurora.ingredient_search.v1",
      query: "niacinamide",
      limit: 5,
      filters: { include_kb_snippets: false },
    },
  );

  assert.equal(out.schema_version, "aurora.ingredient_search.v1");
  assert.equal(out.query, "niacinamide");
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0]?.product_id, "p1");
  assert.ok(out.hits[0]?.match_source.includes("ingredients"));
  assert.ok((out.hits[0]?.matched_terms ?? []).length >= 1);
  assert.ok((out.hits[0]?.score ?? -1) >= 0 && (out.hits[0]?.score ?? 2) <= 1);
});

test("ING-002: matches KB snippets when include_kb_snippets=true", () => {
  const out = searchIngredientDocsV1(
    [
      {
        product_id: "p1",
        display_name: "Brand A Serum",
        region_availability: ["GLOBAL"],
        ingredients_full_list: ["Water", "Glycerin"],
        kb_snippets: ["INCI: Aqua, Glycerin, Parfum."],
      },
    ],
    {
      schema_version: "aurora.ingredient_search.v1",
      query: "fragrance",
      limit: 5,
      filters: { include_kb_snippets: true },
    },
  );

  assert.equal(out.hits.length, 1);
  assert.ok(out.hits[0]?.match_source.includes("kb_snippets"));
});

test("ING-003: region filter excludes non-region products (consistent with vector-service)", () => {
  const out = searchIngredientDocsV1(
    [
      {
        product_id: "p_cn",
        display_name: "Brand Global VitC",
        region_availability: ["Global"],
        ingredients_full_list: ["Water", "Vitamin C"],
      },
      {
        product_id: "p_us",
        display_name: "Brand US VitC",
        region_availability: ["US"],
        ingredients_full_list: ["Water", "Vitamin C"],
      },
    ],
    {
      schema_version: "aurora.ingredient_search.v1",
      query: "vitamin c",
      region: "CN",
      limit: 10,
    },
  );

  assert.equal(out.hits.some((h) => h.product_id === "p_us"), false);
  assert.equal(out.hits.some((h) => h.product_id === "p_cn"), true);
});

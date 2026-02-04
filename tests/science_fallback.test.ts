import assert from "node:assert/strict";
import test from "node:test";

import { buildScienceFallbackAnswerV1 } from "../lib/aurora/science-fallback.ts";

test("SCI-FB-001: fallback is generic (not peptide-XYZ hardcoded)", () => {
  const out = buildScienceFallbackAnswerV1({
    user_query: "烟酰胺到底有没有用？有没有临床证据？",
    regionLabel: "CN",
    external_verification: { query: "niacinamide", citations: [] },
    active_mentions: ["Niacinamide"],
    ingredient_search: {
      schema_version: "aurora.ingredient_search.v1",
      query: "niacinamide",
      hits: [],
      missing_inputs: [],
    },
  });

  assert.ok(out.includes("烟酰胺") || out.includes("Niacinamide"));
  assert.equal(out.includes("Peptide XYZ"), false);
  assert.equal(out.includes("XYZ"), false);
});

test("SCI-FB-002: includes KB product examples when asked", () => {
  const out = buildScienceFallbackAnswerV1({
    user_query: "哪些产品含烟酰胺？",
    regionLabel: "CN",
    external_verification: null,
    active_mentions: ["Niacinamide"],
    ingredient_search: {
      schema_version: "aurora.ingredient_search.v1",
      query: "niacinamide",
      hits: [
        {
          product_id: "p1",
          display_name: "Brand A Serum",
          matched_terms: ["Niacinamide"],
          match_source: ["ingredients"],
          score: 0.95,
        },
        {
          product_id: "p2",
          display_name: "Brand B Cream",
          matched_terms: ["Niacinamide"],
          match_source: ["kb_snippets"],
          score: 0.75,
        },
      ],
      missing_inputs: [],
    },
  });

  assert.ok(out.includes("产品示例"));
  assert.ok(out.includes("Brand A Serum"));
  assert.ok(out.includes("Brand B Cream"));
});

test("SCI-FB-003: English query yields English fallback lead", () => {
  const out = buildScienceFallbackAnswerV1({
    user_query: "Does niacinamide have clinical evidence?",
    regionLabel: "US",
    external_verification: { query: "niacinamide", citations: [] },
    active_mentions: ["Niacinamide"],
    ingredient_search: null,
  });

  assert.ok(out.startsWith("Based on"));
  assert.ok(out.includes("Topic"));
});

test("SCI-FB-004: includes citations when available", () => {
  const out = buildScienceFallbackAnswerV1({
    user_query: "烟酰胺有没有临床证据？",
    regionLabel: "CN",
    external_verification: {
      query: "niacinamide",
      citations: [
        {
          title: "Niacinamide - mechanisms of action and its topical use in dermatology.",
          source: "Skin pharmacology and physiology",
          year: 2014,
          url: "https://pubmed.ncbi.nlm.nih.gov/24993939/",
          note: "PMID:24993939",
        },
      ],
    },
    active_mentions: ["Niacinamide"],
    ingredient_search: null,
  });

  assert.ok(out.includes("参考文献") || out.includes("Selected citations"));
  assert.ok(out.includes("PMID:24993939"));
});

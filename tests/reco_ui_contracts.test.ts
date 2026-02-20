import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMissingInfoForUi } from "../lib/recoMissingInfoUi.ts";

test("normalizeMissingInfoForUi filters internal codes and maps user-facing labels", () => {
  const out = normalizeMissingInfoForUi([
    "reco_dag_timeout_catalog_ann",
    "url_realtime_product_intel_used",
    "price_temporarily_unavailable",
    "social_data_limited",
    "profile_not_provided",
    "internal_debug_only",
  ]);

  assert.deepEqual(out, [
    "Price could not be confirmed from reliable sources yet.",
    "Cross-platform social coverage is limited right now.",
    "Some skin profile inputs are missing; share them for tighter matching.",
  ]);
});

test("normalizeMissingInfoForUi keeps output bounded and deduplicated", () => {
  const out = normalizeMissingInfoForUi([
    "analysis_limited",
    "analysis_limited",
    "analysis_in_progress",
    "alternatives_unavailable",
    "alternatives_limited",
    "product_not_resolved",
    "evidence_limited",
    "ingredient_concentration_unknown",
    "price_temporarily_unavailable",
    "social_data_limited",
  ]);

  assert.ok(out.length <= 6);
  assert.equal(new Set(out).size, out.length);
});


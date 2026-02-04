import assert from "node:assert/strict";
import test from "node:test";

import { calculateScore } from "../lib/engine.ts";
import { AURORA_SKU_DB, DEFAULT_USER_VECTOR } from "../data/mock-db.ts";

test("VETO: 泛红敏感肌 + Tom Ford(含酒精/高刺激) => total score = 0", () => {
  const user = {
    ...DEFAULT_USER_VECTOR,
    skin_type: "sensitive" as const,
    barrier_status: "impaired" as const,
    goals: [
      { track: "redness" as const, priority: 1 },
      { track: "soothing" as const, priority: 1 },
      { track: "repair" as const, priority: 2 },
    ],
  };

  const tomFord = AURORA_SKU_DB.find((s) => s.sku_id === "tf_research_serum");
  assert.ok(tomFord, "Expected tf_research_serum in mock DB");
  assert.ok(tomFord.risk_flags.includes("alcohol"));
  assert.ok(tomFord.risk_flags.includes("high_irritation") || (tomFord.social_stats.burn_rate ?? 0) > 0.1);

  const score = calculateScore(tomFord, user);

  assert.equal(score.vetoed, true);
  assert.equal(score.total, 0);
});

test("EnvStress: ESS applies a bounded score penalty (max 10 points)", () => {
  const sku = AURORA_SKU_DB.find((s) => s.sku_id === "to_copper_peptides");
  assert.ok(sku, "Expected to_copper_peptides in mock DB");

  const base = calculateScore(sku, DEFAULT_USER_VECTOR);
  assert.equal(base.vetoed, false);

  const stressed = calculateScore(sku, {
    ...DEFAULT_USER_VECTOR,
    env_stress: {
      schema_version: "aurora.env_stress.v1",
      ess: 100,
      tier: "High",
      contributors: [{ key: "test" }],
      missing_inputs: [],
      generated_at: "2026-02-03T00:00:00.000Z",
    },
  });

  assert.equal(stressed.vetoed, false);
  assert.ok(base.total - stressed.total > 9.5 && base.total - stressed.total < 10.5);
});

test("Decision Integration: EnvStress missing does not change base score", () => {
  const sku = AURORA_SKU_DB.find((s) => s.sku_id === "to_copper_peptides");
  assert.ok(sku, "Expected to_copper_peptides in mock DB");

  const base = calculateScore(sku, DEFAULT_USER_VECTOR);
  const missing = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: null });

  assert.equal(base.vetoed, false);
  assert.equal(missing.vetoed, false);
  assert.equal(missing.total, base.total);
});

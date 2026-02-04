import assert from "node:assert/strict";
import test from "node:test";

import { AURORA_SKU_DB, DEFAULT_USER_VECTOR } from "../data/mock-db.ts";
import { calculateScore } from "../lib/engine.ts";

function buildEnvStress(ess: number) {
  return {
    schema_version: "aurora.env_stress.v1" as const,
    ess,
    tier: ess < 35 ? "Low" : ess < 65 ? "Moderate" : "High",
    contributors: [{ key: "test" }],
    missing_inputs: [],
    generated_at: "2026-02-03T00:00:00.000Z",
  };
}

function rankSkus(user: any) {
  return AURORA_SKU_DB.map((sku) => ({ sku, score: calculateScore(sku, user) }))
    .sort((a, b) => b.score.total - a.score.total);
}

test("System invariant: EnvStressPenalty is monotonic and bounded (<=10)", () => {
  const sku = AURORA_SKU_DB.find((s) => s.sku_id === "to_copper_peptides");
  assert.ok(sku, "Expected to_copper_peptides in mock DB");

  const base = calculateScore(sku, DEFAULT_USER_VECTOR);
  assert.equal(base.vetoed, false);

  const low = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: buildEnvStress(10) });
  const mid = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: buildEnvStress(50) });
  const high = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: buildEnvStress(100) });

  const penaltyLow = base.total - low.total;
  const penaltyMid = base.total - mid.total;
  const penaltyHigh = base.total - high.total;

  assert.ok(penaltyLow >= -1e-9, `expected non-negative penaltyLow, got ${penaltyLow}`);
  assert.ok(penaltyMid >= -1e-9, `expected non-negative penaltyMid, got ${penaltyMid}`);
  assert.ok(penaltyHigh >= -1e-9, `expected non-negative penaltyHigh, got ${penaltyHigh}`);

  assert.ok(penaltyLow <= penaltyMid + 1e-9, `expected penaltyLow<=penaltyMid, got ${penaltyLow} vs ${penaltyMid}`);
  assert.ok(penaltyMid <= penaltyHigh + 1e-9, `expected penaltyMid<=penaltyHigh, got ${penaltyMid} vs ${penaltyHigh}`);

  assert.ok(penaltyLow <= 10 + 1e-9, `expected penaltyLow<=10, got ${penaltyLow}`);
  assert.ok(penaltyMid <= 10 + 1e-9, `expected penaltyMid<=10, got ${penaltyMid}`);
  assert.ok(penaltyHigh <= 10 + 1e-9, `expected penaltyHigh<=10, got ${penaltyHigh}`);
});

test("System invariant: ranking top1 category is stable with/without EnvStress", () => {
  const goldenUserNoStress = { ...DEFAULT_USER_VECTOR, env_stress: null };
  const goldenUserWithStress = { ...DEFAULT_USER_VECTOR, env_stress: buildEnvStress(100) };

  const noStress = rankSkus(goldenUserNoStress);
  const withStress = rankSkus(goldenUserWithStress);

  const top1NoStress = noStress[0];
  const top1WithStress = withStress[0];
  assert.ok(top1NoStress && top1WithStress);

  // Minimal guarantee: top1 "category" does not flip across major classes.
  assert.equal(top1NoStress.sku.category, top1WithStress.sku.category);

  // If major class check is too weak, also assert VETO population is unchanged.
  const vetoCountNoStress = noStress.filter((r) => r.score.vetoed).length;
  const vetoCountWithStress = withStress.filter((r) => r.score.vetoed).length;
  assert.equal(vetoCountNoStress, vetoCountWithStress);

  // Core output shape: same SKU list length.
  assert.equal(noStress.length, withStress.length);
});

test("System invariant: EnvStress failures do not break scoring (throw/timeout/invalid schema)", async () => {
  const sku = AURORA_SKU_DB.find((s) => s.sku_id === "to_copper_peptides");
  assert.ok(sku, "Expected to_copper_peptides in mock DB");

  const base = calculateScore(sku, DEFAULT_USER_VECTOR);
  assert.equal(base.vetoed, false);

  // Throw: env_stress getter throws (simulates aggregator exception).
  const userThrowing: any = { ...DEFAULT_USER_VECTOR };
  Object.defineProperty(userThrowing, "env_stress", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("env-stress failed");
    },
  });
  const scoreThrowing = calculateScore(sku, userThrowing);
  assert.equal(scoreThrowing.total, base.total);

  // Timeout/invalid value: non-finite ess should be ignored => penalty 0.
  const scoreInfinity = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: buildEnvStress(Number.POSITIVE_INFINITY) as any });
  assert.equal(scoreInfinity.total, base.total);

  // Invalid schema: wrong schema_version + ess as string should be ignored => penalty 0.
  const badEnvStress = { schema_version: "bad", ess: "NaN" } as any;
  const scoreBadSchema = calculateScore(sku, { ...DEFAULT_USER_VECTOR, env_stress: badEnvStress });
  assert.equal(scoreBadSchema.total, base.total);
  assert.equal(typeof scoreBadSchema.total, "number");
  assert.equal(typeof scoreBadSchema.science, "number");
  assert.equal(typeof scoreBadSchema.social, "number");
  assert.equal(typeof scoreBadSchema.engineering, "number");
});

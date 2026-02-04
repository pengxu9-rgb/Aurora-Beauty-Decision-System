import assert from "node:assert/strict";
import test from "node:test";

import { simulateConflictsV1 } from "../lib/conflict-detector.ts";

test("CONFLICT-001: retinoid × acids => warn", () => {
  const out = simulateConflictsV1(
    {
      schema_version: "aurora.conflicts.v1",
      routine: { pm: [{ name: "Retinol Serum", key_actives: ["retinol"] }] },
      test_product: { name: "Glycolic Acid 7%", key_actives: ["glycolic acid"] },
    },
    { lang: "en-US" },
  );

  assert.equal(out.schema_version, "aurora.conflicts.v1");
  assert.equal(out.safe, false);
  assert.ok(out.conflicts.some((c) => c.rule_id === "retinoid_x_acids" && c.severity === "warn"));
});

test("CONFLICT-002: retinoid × benzoyl peroxide => block", () => {
  const out = simulateConflictsV1(
    {
      schema_version: "aurora.conflicts.v1",
      routine: { pm: [{ name: "Adapalene", key_actives: ["adapalene"] }] },
      test_product: { name: "BPO Wash", key_actives: ["benzoyl peroxide"] },
    },
    { lang: "en-US" },
  );

  assert.equal(out.safe, false);
  assert.ok(out.conflicts.some((c) => c.rule_id === "retinoid_x_bpo" && c.severity === "block"));
});

test("CONFLICT-002 (CN tokens): 阿达帕林 × 过氧化苯甲酰 => block", () => {
  const out = simulateConflictsV1(
    {
      schema_version: "aurora.conflicts.v1",
      routine: { pm: [{ name: "阿达帕林", key_actives: ["阿达帕林"] }] },
      test_product: { name: "过氧化苯甲酰", key_actives: ["过氧化苯甲酰"] },
    },
    { lang: "zh-CN" },
  );

  assert.equal(out.safe, false);
  assert.ok(out.conflicts.some((c) => c.rule_id === "retinoid_x_bpo" && c.severity === "block"));
});

test("CONFLICT-003: multiple exfoliants => warn", () => {
  const out = simulateConflictsV1(
    {
      schema_version: "aurora.conflicts.v1",
      routine: {
        pm: [
          { name: "AHA Toner", key_actives: ["glycolic acid"] },
          { name: "BHA Serum", key_actives: ["salicylic acid"] },
        ],
      },
    },
    { lang: "en-US" },
  );

  assert.equal(out.safe, false);
  assert.ok(out.conflicts.some((c) => c.rule_id === "multiple_exfoliants" && c.severity === "warn"));
});


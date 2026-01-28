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

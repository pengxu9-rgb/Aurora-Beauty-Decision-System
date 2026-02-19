import assert from "node:assert/strict";
import test from "node:test";

import { formatSuggestionConfidence, normalizeLlmSuggestion, suggestionLabelText } from "../lib/recoPrelabelUi.ts";

test("normalizeLlmSuggestion parses valid suggestion fields", () => {
  const out = normalizeLlmSuggestion({
    id: "sg_1",
    suggested_label: "wrong_block",
    wrong_block_target: "dupes",
    confidence: 0.73,
    rationale_user_visible: "Category matches but price signal is weak.",
    flags: ["needs_price_check", "needs_price_check", "low_social_signal"],
  });
  assert.ok(out);
  assert.equal(out?.suggestion_id, "sg_1");
  assert.equal(out?.suggested_label, "wrong_block");
  assert.equal(out?.wrong_block_target, "dupes");
  assert.equal(out?.confidence, 0.73);
  assert.deepEqual(out?.flags, ["needs_price_check", "low_social_signal"]);
});

test("normalizeLlmSuggestion drops invalid labels and clamps confidence", () => {
  const out = normalizeLlmSuggestion({
    suggested_label: "maybe",
    wrong_block_target: "unknown",
    confidence: 9,
    flags: ["", "A", "a"],
  });
  assert.ok(out);
  assert.equal(out?.suggested_label, null);
  assert.equal(out?.wrong_block_target, null);
  assert.equal(out?.confidence, 1);
  assert.deepEqual(out?.flags, ["A"]);
});

test("suggestion helpers format labels and confidence", () => {
  assert.equal(suggestionLabelText("relevant"), "相关");
  assert.equal(suggestionLabelText("not_relevant"), "不相关");
  assert.equal(formatSuggestionConfidence(0.456), "46%");
  assert.equal(formatSuggestionConfidence(null), "");
});


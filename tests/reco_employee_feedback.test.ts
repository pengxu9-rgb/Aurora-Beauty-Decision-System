import assert from "node:assert/strict";
import test from "node:test";

import { createRecoFeedbackReporter, parseRecoBlockName } from "../lib/recoEmployeeFeedback.ts";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("reco feedback reporter uses debounce + last-write-wins per candidate key", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const reporter = createRecoFeedbackReporter({
    uid: "uid_1",
    debounceMs: 20,
    sendFeedback: async (payload) => {
      sent.push(payload as unknown as Record<string, unknown>);
    },
    sendClick: async () => {},
  });

  reporter.queueFeedback({
    anchor_product_id: "anchor_1",
    block: "competitors",
    candidate_product_id: "cand_1",
    feedback_type: "relevant",
    request_id: "req_1",
    session_id: "sess_1",
  });
  reporter.queueFeedback({
    anchor_product_id: "anchor_1",
    block: "competitors",
    candidate_product_id: "cand_1",
    feedback_type: "not_relevant",
    request_id: "req_1",
    session_id: "sess_1",
    reason_tags: ["price_off"],
  });

  await wait(60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].feedback_type, "not_relevant");
  assert.deepEqual(sent[0].reason_tags, ["price_off"]);
  assert.equal(typeof sent[0].timestamp, "number");
  reporter.dispose();
});

test("reco feedback reporter sends interleave click payload", async () => {
  const clicks: Array<Record<string, unknown>> = [];
  const reporter = createRecoFeedbackReporter({
    uid: "uid_2",
    sendFeedback: async () => {},
    sendClick: async (payload) => {
      clicks.push(payload as unknown as Record<string, unknown>);
    },
  });

  await reporter.sendInterleaveClick({
    anchor_product_id: "anchor_2",
    block: "dupes",
    candidate_product_id: "cand_dupe",
    request_id: "req_2",
    session_id: "sess_2",
  });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].block, "dupes");
  assert.equal(typeof clicks[0].timestamp, "number");
  reporter.dispose();
});

test("parseRecoBlockName only accepts supported blocks", () => {
  assert.equal(parseRecoBlockName("competitors"), "competitors");
  assert.equal(parseRecoBlockName("related_products"), "related_products");
  assert.equal(parseRecoBlockName("dupes"), "dupes");
  assert.equal(parseRecoBlockName("random"), null);
});

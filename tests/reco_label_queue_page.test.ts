import assert from "node:assert/strict";
import test from "node:test";

import { buildLabelQueueQuery, fetchLabelQueue } from "../lib/recoLabelQueueClient.ts";

test("buildLabelQueueQuery serializes queue filters", () => {
  const query = buildLabelQueueQuery({
    block: "competitors",
    limit: 25,
    anchor_product_id: "anchor_1",
    low_confidence: true,
    wrong_block_only: true,
    exploration_only: true,
    missing_info_only: true,
  });
  const qp = new URLSearchParams(query);
  assert.equal(qp.get("block"), "competitors");
  assert.equal(qp.get("limit"), "25");
  assert.equal(qp.get("anchor_product_id"), "anchor_1");
  assert.equal(qp.get("low_confidence"), "true");
  assert.equal(qp.get("wrong_block_only"), "true");
  assert.equal(qp.get("exploration_only"), "true");
  assert.equal(qp.get("missing_info_only"), "true");
});

test("fetchLabelQueue returns parsed payload", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        ok: true,
        items: [
          {
            suggestion_id: "sg_1",
            anchor_product_id: "anchor_1",
            block: "competitors",
            candidate_product_id: "cand_1",
            suggested_label: "relevant",
            wrong_block_target: null,
            confidence: 0.8,
            rationale_user_visible: "Looks relevant.",
            flags: [],
            priority_score: 0.25,
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const out = await fetchLabelQueue({ block: "competitors", limit: 10 });
    assert.equal(out.ok, true);
    assert.equal(Array.isArray(out.items), true);
    assert.equal(out.items[0]?.suggestion_id, "sg_1");
    assert.match(calls[0] || "", /\/api\/reco\/label-queue\?/);
    assert.match(calls[0] || "", /block=competitors/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


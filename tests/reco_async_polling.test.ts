import assert from "node:assert/strict";
import test from "node:test";

import { lockTopNOrder, mergeRecoPayloadWithAsyncPatch, startRecoAsyncPolling } from "../lib/recoRealtimeUpdates.ts";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("lockTopNOrder keeps top-N order while refreshing locked item content", () => {
  const current = [
    { product_id: "a", summary: "old_a" },
    { product_id: "b", summary: "old_b" },
    { product_id: "c", summary: "old_c" },
  ];
  const next = [
    { product_id: "b", summary: "new_b" },
    { product_id: "c", summary: "new_c" },
    { product_id: "a", summary: "new_a" },
    { product_id: "d", summary: "new_d" },
  ];
  const out = lockTopNOrder(current, next, 2);
  assert.deepEqual(out.slice(0, 2).map((x) => x.product_id), ["a", "b"]);
  assert.equal(out[0]?.summary, "new_a");
  assert.equal(out[1]?.summary, "new_b");
});

test("mergeRecoPayloadWithAsyncPatch merges block patch and provenance", () => {
  const current = {
    competitors: { candidates: [{ product_id: "a" }, { product_id: "b" }] },
    related_products: { candidates: [{ product_id: "r1" }] },
    dupes: { candidates: [] },
    provenance: { lock_top_n_on_first_paint: 3, pipeline: "v1" },
  };
  const patch = {
    competitors: { candidates: [{ product_id: "b" }, { product_id: "a" }, { product_id: "c" }] },
    provenance: { pipeline: "v1_async" },
  };
  const merged = mergeRecoPayloadWithAsyncPatch(current, patch, 2);
  const comp = (merged.competitors as any).candidates;
  assert.deepEqual(comp.slice(0, 2).map((x: any) => x.product_id), ["a", "b"]);
  assert.equal((merged.provenance as any).pipeline, "v1_async");
});

test("startRecoAsyncPolling emits patch when version advances", async () => {
  const patches: Array<{ version: number; payload: Record<string, unknown> }> = [];
  const responses = [
    { ok: true, version: 1, has_update: false },
    {
      ok: true,
      version: 2,
      has_update: true,
      payload_patch: { competitors: { candidates: [{ product_id: "x1" }] } },
    },
  ];
  let idx = 0;
  let stop = () => {};

  stop = startRecoAsyncPolling({
    uid: "uid_poll",
    ticketId: "ticket_1",
    sinceVersion: 1,
    intervalMs: 25,
    requestAsyncUpdates: async () => {
      const out = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return out;
    },
    onPatch: (payload, version) => {
      patches.push({ version, payload });
      stop();
    },
  });

  await wait(140);
  stop();
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.version, 2);
  const candidates = ((patches[0]?.payload.competitors as any)?.candidates || []).map((x: any) => x.product_id);
  assert.deepEqual(candidates, ["x1"]);
});

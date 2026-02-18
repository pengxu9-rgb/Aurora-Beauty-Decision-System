import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConflictHeatmapUiModelV1, normalizeEnvStressUiModelV1 } from "../lib/ui-contracts.ts";
import { extractDogfoodViewModel } from "../lib/recoDogfoodView.ts";

test("UI-001: Radar clamps values to 0..100", () => {
  const input = {
    schema_version: "aurora.ui.env_stress.v1",
    ess: 88,
    tier: "TODO(report)",
    radar: [
      { axis: "Hydration", value: 120 },
      { axis: "Sensitivity", value: -5 },
    ],
    notes: ["..."],
  };

  const { model, didWarn } = normalizeEnvStressUiModelV1(input);
  assert.ok(model);
  assert.equal(model.schema_version, "aurora.ui.env_stress.v1");
  assert.equal(didWarn, false);

  const hydration = model.radar.find((d) => d.axis === "Hydration")?.value;
  const sensitivity = model.radar.find((d) => d.axis === "Sensitivity")?.value;
  assert.equal(hydration, 100);
  assert.equal(sensitivity, 0);
});

test("UI-002: Non-finite radar values fallback to 0 and surface didWarn", () => {
  const input = {
    schema_version: "aurora.ui.env_stress.v1",
    ess: null,
    tier: null,
    radar: [{ axis: "Hydration", value: "NaN" }],
    notes: [],
  };

  const { model, didWarn } = normalizeEnvStressUiModelV1(input);
  assert.ok(model);
  assert.equal(didWarn, true);
  assert.equal(model.radar[0]?.value, 0);
});

test("UI-003: Heatmap contract placeholder does not require extra fields", () => {
  const input = {
    schema_version: "aurora.ui.conflict_heatmap.v1",
    "TODO(report)": "define matrix axes + buckets + colors",
  };

  const out = normalizeConflictHeatmapUiModelV1(input);
  assert.deepEqual(out, { schema_version: "aurora.ui.conflict_heatmap.v1" });
});

test("UI-004: Dogfood provenance parser reads employee controls and async ticket", () => {
  const vm = extractDogfoodViewModel({
    provenance: {
      dogfood_mode: true,
      dogfood_features_effective: {
        show_employee_feedback_controls: true,
      },
      async_ticket_id: "ticket_123",
      lock_top_n_on_first_paint: 3,
      pipeline: "reco_blocks_dag.v1",
      interleave: {
        enabled: true,
        rankerA: "ranker_v1",
        rankerB: "ranker_v2",
      },
    },
  });
  assert.equal(vm.dogfood_mode, true);
  assert.equal(vm.show_employee_feedback_controls, true);
  assert.equal(vm.async_ticket_id, "ticket_123");
  assert.equal(vm.lock_top_n_on_first_paint, 3);
  assert.equal(vm.pipeline_version, "reco_blocks_dag.v1");
  assert.equal((vm.models as Record<string, unknown>).rankerA, "ranker_v1");
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvStressApiResponse, calculateStressScore } from "../lib/env-stress.ts";

const NOW = new Date("2026-02-03T00:00:00.000Z");

test("EnvStress: no signals => ess null + contributors non-empty", () => {
  const out = calculateStressScore({ schema_version: "aurora.env_stress.v1", profile: {}, recent_logs: [] }, { now: NOW });

  assert.equal(out.schema_version, "aurora.env_stress.v1");
  assert.equal(out.generated_at, NOW.toISOString());
  assert.equal(out.ess, null);
  assert.equal(out.tier, null);
  assert.ok(out.contributors.length > 0);

  assert.ok(out.missing_inputs.includes("profile.barrier_status"));
  assert.ok(out.missing_inputs.includes("profile.sensitivity"));
  assert.ok(out.missing_inputs.includes("recent_logs"));
  assert.ok(!out.missing_inputs.includes("env.*"));
});

test("EnvStress: env provided but empty => exposes missing env inputs", () => {
  const out = calculateStressScore(
    {
      schema_version: "aurora.env_stress.v1",
      profile: {
        skin_type: "sensitive",
        barrier_status: "impaired",
        sensitivity: "high",
        goals: ["redness", "repair"],
        region: null,
      },
      recent_logs: [{ date: "2026-02-01", redness: 4, hydration: 1, acne: 0 }],
      env: {},
    },
    { now: NOW },
  );

  assert.equal(out.generated_at, NOW.toISOString());
  assert.ok(out.contributors.length > 0);
  assert.ok(out.missing_inputs.includes("env.*"));
  assert.ok(out.ess == null || (out.ess >= 0 && out.ess <= 100));
});

test("EnvStress: profile+logs => computes ESS and has empty missing_inputs", () => {
  const out = calculateStressScore(
    {
      schema_version: "aurora.env_stress.v1",
      profile: {
        skin_type: "oily",
        barrier_status: "healthy",
        sensitivity: "low",
        goals: ["acne"],
        region: "US",
      },
      recent_logs: [{ date: "2026-02-02", redness: 0, hydration: 3, acne: 2 }],
    },
    { now: NOW },
  );

  assert.equal(out.generated_at, NOW.toISOString());
  assert.ok(out.ess != null);
  assert.ok(out.ess >= 0 && out.ess <= 100);
  assert.deepEqual(out.missing_inputs, []);
  assert.ok(out.contributors.length > 0);
  assert.ok(out.tier);
});

test("EnvStress: mixed-scale logs normalize to 0..5", () => {
  const out = calculateStressScore(
    {
      schema_version: "aurora.env_stress.v1",
      profile: {
        skin_type: "combination",
        barrier_status: "impaired",
        sensitivity: "medium",
        goals: ["brightening"],
        region: "CN",
      },
      recent_logs: [{ date: "2026-02-02", redness: 80, hydration: 20, acne: 0 }],
    },
    { now: NOW },
  );

  const rednessNote = out.contributors.find((c) => c.key === "redness")?.note ?? "";
  const hydrationNote = out.contributors.find((c) => c.key === "hydration")?.note ?? "";
  assert.ok(rednessNote.includes("recent_redness=4/5"), `unexpected redness note: ${rednessNote}`);
  assert.ok(hydrationNote.includes("recent_hydration=1/5"), `unexpected hydration note: ${hydrationNote}`);
});

test("EnvStress API: rejects non-object body", () => {
  const res = buildEnvStressApiResponse(null);
  assert.equal(res.status, 400);
  assert.equal((res.json as any).error, "Invalid request body");
  assert.ok(Array.isArray((res.json as any).issues));
});

test("EnvStress API: rejects wrong schema_version", () => {
  const res = buildEnvStressApiResponse({ schema_version: "nope", profile: {} });
  assert.equal(res.status, 400);
  assert.equal((res.json as any).error, "Invalid request");
  assert.ok(((res.json as any).issues as string[]).some((s) => s.includes("schema_version")));
});

test("EnvStress API: rejects invalid profile type", () => {
  const res = buildEnvStressApiResponse({ schema_version: "aurora.env_stress.v1", profile: "bad" });
  assert.equal(res.status, 400);
  assert.equal((res.json as any).error, "Invalid request");
  assert.ok(((res.json as any).issues as string[]).some((s) => s.includes("profile must be an object")));
});


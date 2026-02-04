import type { EnvStressInputV1, EnvStressOutputV1 } from "@/types";

type ParseOk<T> = { ok: true; data: T };
type ParseErr = { ok: false; error: string; issues: string[] };
export type ParseResult<T> = ParseOk<T> | ParseErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clamp100(value: number) {
  return clamp(value, 0, 100);
}

function coerceNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeScale05(value: unknown): number | null {
  const n = coerceNumber(value);
  if (n == null) return null;

  // Support 0..5 or 0..100 inputs.
  const v = n > 5 ? n / 20 : n;
  return clamp(v, 0, 5);
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function normalizeBarrierFactor(raw: string): { factor: number; label: string } {
  const v = raw.trim().toLowerCase();
  if (!v) return { factor: 0.45, label: "unknown" };
  if (v.includes("impaired") || v.includes("irrit") || v.includes("unstable") || v.includes("刺痛") || v.includes("泛红")) {
    return { factor: 0.7, label: "impaired" };
  }
  if (v.includes("healthy") || v.includes("stable") || v.includes("ok") || v.includes("稳定")) {
    return { factor: 0.2, label: "healthy" };
  }
  return { factor: 0.45, label: "unknown" };
}

function normalizeSensitivityFactor(raw: string): { factor: number; label: string } {
  const v = raw.trim().toLowerCase();
  if (!v) return { factor: 0.5, label: "unknown" };
  if (v === "low" || v.includes("低")) return { factor: 0.2, label: "low" };
  if (v === "medium" || v === "mid" || v.includes("中")) return { factor: 0.45, label: "medium" };
  if (v === "high" || v.includes("高")) return { factor: 0.7, label: "high" };
  return { factor: 0.5, label: "unknown" };
}

function pickLatestLog(
  logs: NonNullable<EnvStressInputV1["recent_logs"]>,
): NonNullable<EnvStressInputV1["recent_logs"]>[number] | null {
  const filtered = logs.filter((l) => l && isIsoDate(l.date));
  if (!filtered.length) return null;
  return [...filtered].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] ?? null;
}

export function parseEnvStressInputV1(value: unknown): ParseResult<EnvStressInputV1> {
  const issues: string[] = [];
  if (!isPlainObject(value)) return { ok: false, error: "Invalid request body", issues: ["body must be an object"] };

  const schemaVersion = value.schema_version;
  if (schemaVersion !== "aurora.env_stress.v1") {
    issues.push('schema_version must be "aurora.env_stress.v1"');
  }

  if (!isPlainObject(value.profile)) {
    issues.push("profile must be an object");
  }

  if ("recent_logs" in value && value.recent_logs != null) {
    if (!Array.isArray(value.recent_logs)) {
      issues.push("recent_logs must be an array");
    } else {
      for (const [idx, item] of value.recent_logs.entries()) {
        if (!isPlainObject(item)) {
          issues.push(`recent_logs[${idx}] must be an object`);
          continue;
        }
        if (!isIsoDate(item.date)) issues.push(`recent_logs[${idx}].date must be YYYY-MM-DD`);

        for (const k of ["redness", "hydration", "acne"] as const) {
          if (!(k in item)) continue;
          const v = (item as any)[k];
          if (v == null) continue;
          if (typeof v !== "number" && typeof v !== "string") issues.push(`recent_logs[${idx}].${k} must be a number`);
        }
      }
    }
  }

  if ("env" in value && value.env != null && !isPlainObject(value.env)) {
    issues.push("env must be an object");
  }

  if (issues.length) return { ok: false, error: "Invalid request", issues };

  return { ok: true, data: value as EnvStressInputV1 };
}

function inferTier(ess: number): "Low" | "Moderate" | "High" {
  if (ess < 35) return "Low";
  if (ess < 65) return "Moderate";
  return "High";
}

export function calculateStressScore(
  input: EnvStressInputV1,
  opts: { now?: Date } = {},
): EnvStressOutputV1 {
  const nowIso = (opts.now ?? new Date()).toISOString();

  const missing_inputs: string[] = [];

  const profile = isPlainObject(input.profile) ? input.profile : {};
  const barrierStatusRaw = hasText(profile.barrier_status) ? profile.barrier_status : "";
  const sensitivityRaw = hasText(profile.sensitivity) ? profile.sensitivity : "";

  const hasAnyProfileSignal = Boolean(barrierStatusRaw || sensitivityRaw || (Array.isArray(profile.goals) && profile.goals.length));

  if (!barrierStatusRaw) missing_inputs.push("profile.barrier_status");
  if (!sensitivityRaw) missing_inputs.push("profile.sensitivity");

  const logs = Array.isArray(input.recent_logs) ? input.recent_logs : [];
  const latestLog = logs.length ? pickLatestLog(logs) : null;

  const redness05 = latestLog ? normalizeScale05(latestLog.redness) : null;
  const hydration05 = latestLog ? normalizeScale05(latestLog.hydration) : null;
  const acne05 = latestLog ? normalizeScale05(latestLog.acne) : null;

  const hasAnyLogSignal = redness05 != null || hydration05 != null || acne05 != null;
  if (!hasAnyLogSignal) missing_inputs.push("recent_logs");

  const envProvided = Object.prototype.hasOwnProperty.call(input, "env");
  const envObj = isPlainObject(input.env) ? input.env : null;
  if (envProvided && (!envObj || Object.keys(envObj).length === 0)) missing_inputs.push("env.*");

  const factors: Array<{ key: string; factor: number; note: string }> = [];

  if (barrierStatusRaw) {
    const b = normalizeBarrierFactor(barrierStatusRaw);
    factors.push({
      key: "barrier",
      factor: b.factor,
      note: `barrier_status=${b.label}`,
    });
  }

  if (sensitivityRaw) {
    const s = normalizeSensitivityFactor(sensitivityRaw);
    factors.push({
      key: "sensitivity",
      factor: s.factor,
      note: `sensitivity=${s.label}`,
    });
  }

  if (redness05 != null) {
    factors.push({
      key: "redness",
      factor: clamp01(redness05 / 5),
      note: `recent_redness=${round1(redness05)}/5`,
    });
  }

  if (hydration05 != null) {
    factors.push({
      key: "hydration",
      factor: clamp01(1 - hydration05 / 5),
      note: `recent_hydration=${round1(hydration05)}/5 (lower hydration => higher stress)`,
    });
  }

  if (acne05 != null) {
    factors.push({
      key: "acne",
      factor: clamp01(acne05 / 5),
      note: `recent_acne=${round1(acne05)}/5`,
    });
  }

  const hasAnySignal = hasAnyProfileSignal || hasAnyLogSignal || (envObj && Object.keys(envObj).length > 0);

  if (!hasAnySignal) {
    return {
      schema_version: "aurora.env_stress.v1",
      ess: null,
      tier: null,
      contributors: [
        {
          key: "missing_inputs",
          note: "Insufficient signals to compute ESS (need profile/log/env inputs).",
        },
      ],
      missing_inputs,
      generated_at: nowIso,
    };
  }

  // Base weights (normalized across available factors).
  const baseWeights: Record<string, number> = {
    barrier: 0.35,
    sensitivity: 0.25,
    redness: 0.2,
    hydration: 0.1,
    acne: 0.1,
  };

  const weightSum = factors.reduce((acc, f) => acc + (baseWeights[f.key] ?? 0), 0);
  const normalizedWeightSum = weightSum > 0 ? weightSum : factors.length;

  const weighted =
    factors.reduce((acc, f) => {
      const w = weightSum > 0 ? (baseWeights[f.key] ?? 0) / normalizedWeightSum : 1 / normalizedWeightSum;
      return acc + clamp01(f.factor) * w;
    }, 0) * 100;

  const ess = round1(clamp100(weighted));
  const tier = inferTier(ess);

  const contributors = factors.map((f) => {
    const w = weightSum > 0 ? (baseWeights[f.key] ?? 0) / normalizedWeightSum : 1 / normalizedWeightSum;
    return { key: f.key, weight: round1(w), note: f.note };
  });

  if (contributors.length === 0) {
    contributors.push({ key: "missing_inputs", weight: 0, note: "No usable factors; computed with fallback assumptions." });
  }

  return {
    schema_version: "aurora.env_stress.v1",
    ess,
    tier,
    contributors,
    missing_inputs,
    generated_at: nowIso,
  };
}

export function buildEnvStressApiResponse(body: unknown, opts: { now?: Date } = {}): { status: number; json: unknown } {
  const parsed = parseEnvStressInputV1(body);
  if (!parsed.ok) return { status: 400, json: { error: parsed.error, issues: parsed.issues } };
  return { status: 200, json: calculateStressScore(parsed.data, { now: opts.now }) };
}

import type { ConflictHeatmapUiModelV1, EnvStressUiModelV1, RadarDatumV1, UiRenderingConstraintsV1 } from "@/types";

export const UI_RENDERING_CONSTRAINTS_V1: UiRenderingConstraintsV1 = {
  schema_version: "aurora.ui.constraints.v1",
  value_range: "0..100",
  nan_policy: "clamp_to_0_and_warn",
  max_axes: 8,
  max_notes: 4,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function clamp0to100(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function normalizeRadarSeriesV1(value: unknown): { radar: RadarDatumV1[]; didWarn: boolean } {
  const out: RadarDatumV1[] = [];
  let didWarn = false;

  if (!Array.isArray(value)) return { radar: out, didWarn };

  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const axis = typeof item.axis === "string" ? item.axis.trim() : "";
    if (!axis) continue;

    const rawValue = item.value;
    const n = coerceNumber(rawValue);
    if (n == null) didWarn = true;

    out.push({ axis: axis.slice(0, 40), value: clamp0to100(n ?? 0) });
    if (out.length >= UI_RENDERING_CONSTRAINTS_V1.max_axes) break;
  }

  return { radar: out, didWarn };
}

export function normalizeNotesV1(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.slice(0, 220));
    if (out.length >= UI_RENDERING_CONSTRAINTS_V1.max_notes) break;
  }
  return out;
}

export function normalizeEnvStressUiModelV1(value: unknown): { model: EnvStressUiModelV1 | null; didWarn: boolean } {
  if (!isPlainObject(value)) return { model: null, didWarn: false };
  if (value.schema_version !== "aurora.ui.env_stress.v1") return { model: null, didWarn: false };

  const essRaw = coerceNumber(value.ess);
  const ess = essRaw == null ? null : clamp0to100(essRaw);

  const tier = typeof value.tier === "string" ? value.tier.trim().slice(0, 40) || null : null;
  const notes = normalizeNotesV1(value.notes);

  const { radar, didWarn } = normalizeRadarSeriesV1(value.radar);

  return {
    model: { schema_version: "aurora.ui.env_stress.v1", ess, tier, radar, notes },
    didWarn,
  };
}

export function normalizeConflictHeatmapUiModelV1(value: unknown): ConflictHeatmapUiModelV1 | null {
  if (!isPlainObject(value)) return null;
  if (value.schema_version !== "aurora.ui.conflict_heatmap.v1") return null;
  return { schema_version: "aurora.ui.conflict_heatmap.v1" };
}


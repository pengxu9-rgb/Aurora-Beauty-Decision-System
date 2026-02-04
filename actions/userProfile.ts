"use server";

import { bffRequest, type BffCard, type BffEnvelope, type AuroraLang, normalizeAuroraLang } from "@/lib/pivotaAgentBff";
import { calculateStressScore } from "@/lib/env-stress";
import { normalizeNotesV1, normalizeRadarSeriesV1 } from "@/lib/ui-contracts";
import type { EnvStressInputV1, EnvStressUiModelV1 } from "@/types";

export type SkinLogInput = {
  date?: string | Date;
  rednessLevel: number;
  acneCount?: number;
  hydration?: number;
  targetProduct?: string | null;
  sensation?: string | null;
  notes?: string | null;
};

export type SkinIdentitySnapshot = {
  userId: string;
  skinType: string | null;
  barrierStatus: string | null;
  concerns: string[];
  status: "good" | "attention";
  resilienceScore: number; // 0-100
  hydration: number; // 0-100
  sebum: number; // 0-100
  sensitivity: number; // 0-100
  last7d: { rednessMax: number; rednessLatest: number };
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};

const clampPercent = (value: number) => clampInt(value, 0, 100, 0);

const normalizeOptionalString = (value: unknown, maxLen: number) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
};

const normalizeStringList = (value: unknown, maxItems: number, maxLen: number) => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
};

const coerceDate = (value: unknown) => {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
};

type BffProfileSummary = {
  skinType?: string | null;
  barrierStatus?: string | null;
  sensitivity?: string | null;
  goals?: string[];
  region?: string | null;
};

type BffSkinLog = {
  date?: string | null;
  redness?: number | null;
  acne?: number | null;
  hydration?: number | null;
  notes?: string | null;
};

function normalizeUserId(userId: string) {
  const normalizedUserId = typeof userId === "string" ? userId.trim().slice(0, 128) : "";
  if (!normalizedUserId) throw new Error("userId is required");
  return normalizedUserId;
}

function extractCard(envelope: BffEnvelope, type: string): BffCard | null {
  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  return cards.find((c) => c && typeof c === "object" && (c as any).type === type) ?? null;
}

function extractBootstrap(envelope: BffEnvelope): { profile: BffProfileSummary | null; recentLogs: BffSkinLog[] } {
  const card = extractCard(envelope, "session_bootstrap");
  const payload = card && card.payload && typeof card.payload === "object" ? (card.payload as any) : null;
  const profile = payload && payload.profile && typeof payload.profile === "object" ? (payload.profile as BffProfileSummary) : null;
  const recentLogs = Array.isArray(payload?.recent_logs) ? (payload.recent_logs as BffSkinLog[]) : [];
  return { profile, recentLogs };
}

function inferSebum(skinType: string | null) {
  const st = (skinType ?? "").toLowerCase();
  if (st.includes("oily")) return 82;
  if (st.includes("dry")) return 28;
  if (st.includes("combo")) return 60;
  if (st.includes("normal")) return 50;
  return 50;
}

function inferHydration(skinType: string | null, barrierStatus: string | null) {
  const st = (skinType ?? "").toLowerCase();
  let base = 50;
  if (st.includes("oily")) base = 56;
  if (st.includes("dry")) base = 36;
  if (st.includes("combo")) base = 48;
  if (st.includes("normal")) base = 60;

  const bs = (barrierStatus ?? "").toLowerCase();
  if (bs.includes("impaired") || bs.includes("irritated")) base -= 8;
  return clampPercent(base);
}

function inferSensitivity(barrierStatus: string | null, concerns: string[], rednessLatest: number) {
  const bs = (barrierStatus ?? "").toLowerCase();
  let base = 48;
  if (bs.includes("healthy") || bs.includes("stable")) base = 32;
  if (bs.includes("impaired")) base = 68;

  const joined = concerns.join(" ").toLowerCase();
  if (joined.includes("redness") || joined.includes("irritation") || joined.includes("sensitive") || joined.includes("stinging")) base += 8;
  base += Math.max(0, Math.min(5, rednessLatest)) * 8;
  return clampPercent(base);
}

function inferResilience(barrierStatus: string | null, sensitivity: number) {
  const bs = (barrierStatus ?? "").toLowerCase();
  const modifier = bs.includes("healthy") ? 6 : bs.includes("impaired") ? -6 : 0;
  return clampPercent(100 - sensitivity + modifier);
}

function normalizeBffSkinLog(log: BffSkinLog) {
  const redness = clampInt(log.redness ?? 0, 0, 5, 0);
  return { redness };
}

function normalizeScale05(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const v = n > 5 ? n / 20 : n;
  return Math.max(0, Math.min(5, v));
}

function mapBarrierTo0to100(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes("impaired") || v.includes("irrit") || v.includes("unstable") || v.includes("刺痛") || v.includes("泛红")) return 70;
  if (v.includes("healthy") || v.includes("stable") || v.includes("ok") || v.includes("稳定")) return 20;
  return 45;
}

function mapSensitivityTo0to100(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "low" || v.includes("低")) return 20;
  if (v === "medium" || v === "mid" || v.includes("中")) return 45;
  if (v === "high" || v.includes("高")) return 70;
  return 50;
}

function buildEnvStressUiModel({ profile, recentLogs, lang }: { profile: BffProfileSummary | null; recentLogs: BffSkinLog[]; lang: AuroraLang }): EnvStressUiModelV1 {
  const normalizedProfile: EnvStressInputV1["profile"] = {
    ...(typeof profile?.skinType === "string" ? { skin_type: profile.skinType } : {}),
    ...(typeof profile?.barrierStatus === "string" ? { barrier_status: profile.barrierStatus } : {}),
    ...(typeof profile?.sensitivity === "string" ? { sensitivity: profile.sensitivity } : {}),
    ...(Array.isArray(profile?.goals) ? { goals: profile.goals.slice(0, 12) } : {}),
    ...(typeof profile?.region === "string" ? { region: profile.region } : {}),
  };

  const normalizedLogs: NonNullable<EnvStressInputV1["recent_logs"]> = [];
  for (const l of Array.isArray(recentLogs) ? recentLogs.slice(0, 30) : []) {
    const date = typeof l?.date === "string" ? l.date.trim().slice(0, 10) : "";
    if (!date) continue;
    normalizedLogs.push({
      date,
      ...(l.redness != null ? { redness: l.redness } : {}),
      ...(l.hydration != null ? { hydration: l.hydration } : {}),
      ...(l.acne != null ? { acne: l.acne } : {}),
    });
  }

  const envStress = calculateStressScore(
    { schema_version: "aurora.env_stress.v1", profile: normalizedProfile, ...(normalizedLogs.length ? { recent_logs: normalizedLogs } : {}) },
    {},
  );

  const latest = normalizedLogs.length ? [...normalizedLogs].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] : null;
  const hydration05 = latest ? normalizeScale05(latest.hydration) : null;
  const redness05 = latest ? normalizeScale05(latest.redness) : null;
  const acne05 = latest ? normalizeScale05(latest.acne) : null;

  const radarRaw: Array<{ axis: string; value: unknown }> = [];
  if (envStress.ess != null) radarRaw.push({ axis: "ESS", value: envStress.ess });
  const barrier = mapBarrierTo0to100(normalizedProfile.barrier_status);
  if (barrier != null) radarRaw.push({ axis: "Barrier", value: barrier });
  const sensitivity = mapSensitivityTo0to100(normalizedProfile.sensitivity);
  if (sensitivity != null) radarRaw.push({ axis: "Sensitivity", value: sensitivity });
  if (hydration05 != null) radarRaw.push({ axis: "Hydration", value: Math.round((hydration05 / 5) * 100) });
  if (redness05 != null) radarRaw.push({ axis: "Redness", value: Math.round((redness05 / 5) * 100) });
  if (acne05 != null) radarRaw.push({ axis: "Acne", value: Math.round((acne05 / 5) * 100) });

  const summaryLine =
    envStress.ess == null
      ? lang === "CN"
        ? "ESS 暂不可用（输入不足）。"
        : "ESS unavailable (insufficient inputs)."
      : lang === "CN"
        ? `ESS ${envStress.ess}/100（${envStress.tier ?? "—"}）`
        : `ESS ${envStress.ess}/100 (${envStress.tier ?? "—"})`;

  const contributorNotes = envStress.contributors
    .map((c) => (typeof c.note === "string" ? c.note : ""))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  const missingLine =
    envStress.missing_inputs.length > 0
      ? lang === "CN"
        ? `缺失：${envStress.missing_inputs.slice(0, 3).join("、")}`
        : `Missing: ${envStress.missing_inputs.slice(0, 3).join(", ")}`
      : null;

  const notesRaw = [summaryLine, ...contributorNotes, ...(missingLine ? [missingLine] : [])];

  const { radar } = normalizeRadarSeriesV1(radarRaw);
  const notes = normalizeNotesV1(notesRaw);

  return {
    schema_version: "aurora.ui.env_stress.v1",
    ess: envStress.ess,
    tier: envStress.tier,
    radar,
    notes,
  };
}

export async function getSkinIdentitySnapshot(userId: string): Promise<SkinIdentitySnapshot> {
  const uid = normalizeUserId(userId);
  const lang: AuroraLang = normalizeAuroraLang(process.env.AURORA_LANG_DEFAULT);

  const envelope = await bffRequest<BffEnvelope>("/v1/session/bootstrap", { uid, lang, method: "GET" });
  const { profile, recentLogs } = extractBootstrap(envelope);

  const rednessValues = recentLogs.map((l) => normalizeBffSkinLog(l).redness);
  const rednessLatest = clampInt(rednessValues[0] ?? 0, 0, 5, 0);
  const rednessMax = clampInt(Math.max(0, ...rednessValues), 0, 5, 0);

  const skinType = typeof profile?.skinType === "string" ? profile.skinType : null;
  const barrierStatus = typeof profile?.barrierStatus === "string" ? profile.barrierStatus : null;
  const concerns = Array.isArray(profile?.goals) ? profile?.goals.slice(0, 12) : [];
  const sensitivity = inferSensitivity(barrierStatus, concerns, rednessLatest);

  return {
    userId: uid,
    skinType,
    barrierStatus,
    concerns,
    status: (barrierStatus ?? "").toLowerCase().includes("healthy") && rednessLatest <= 1 ? "good" : "attention",
    resilienceScore: inferResilience(barrierStatus, sensitivity),
    hydration: inferHydration(skinType, barrierStatus),
    sebum: inferSebum(skinType),
    sensitivity,
    last7d: { rednessMax, rednessLatest },
  };
}

export async function getEnvStressUiModel(userId: string): Promise<EnvStressUiModelV1> {
  const uid = normalizeUserId(userId);
  const lang: AuroraLang = normalizeAuroraLang(process.env.AURORA_LANG_DEFAULT);

  const envelope = await bffRequest<BffEnvelope>("/v1/session/bootstrap", { uid, lang, method: "GET" });
  const { profile, recentLogs } = extractBootstrap(envelope);

  return buildEnvStressUiModel({ profile, recentLogs, lang });
}

export async function setUserConcerns(userId: string, concerns: string[]) {
  const uid = normalizeUserId(userId);
  const normalized = normalizeStringList(concerns, 12, 48);
  const lang: AuroraLang = normalizeAuroraLang(process.env.AURORA_LANG_DEFAULT);
  await bffRequest<BffEnvelope>("/v1/profile/update", { uid, lang, method: "POST", body: { goals: normalized } });
  return getSkinIdentitySnapshot(uid);
}

export async function logSkinStatus(userId: string, data: SkinLogInput) {
  const uid = normalizeUserId(userId);
  const lang: AuroraLang = normalizeAuroraLang(process.env.AURORA_LANG_DEFAULT);

  const rednessLevel = clampInt(data.rednessLevel, 0, 5, 0);
  const hydration = clampInt(data.hydration ?? 0, 0, 5, 0);

  const date = coerceDate(data.date);
  const targetProduct = normalizeOptionalString(data.targetProduct, 200);
  const sensation = normalizeOptionalString(data.sensation, 80);
  const notes = normalizeOptionalString(data.notes, 2000);

  const isoDate = date ? date.toISOString().slice(0, 10) : undefined;

  return bffRequest<BffEnvelope>("/v1/tracker/log", {
    uid,
    lang,
    method: "POST",
    body: {
      ...(isoDate ? { date: isoDate } : {}),
      redness: rednessLevel,
      hydration,
      ...(typeof notes === "string" ? { notes } : {}),
      ...(typeof targetProduct === "string" ? { targetProduct } : {}),
      ...(typeof sensation === "string" ? { sensation } : {}),
    },
  });
}

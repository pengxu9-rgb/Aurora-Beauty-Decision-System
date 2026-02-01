"use server";

import { prisma } from "@/lib/server/prisma";

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

export async function getOrCreateProfile(userId: string) {
  const normalizedUserId = typeof userId === "string" ? userId.trim().slice(0, 128) : "";
  if (!normalizedUserId) throw new Error("userId is required");

  return prisma.userProfile.upsert({
    where: { userId: normalizedUserId },
    update: {},
    create: { userId: normalizedUserId, concerns: [] },
  });
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
  if (bs.includes("impaired")) base -= 8;
  return clampPercent(base);
}

function inferSensitivity(barrierStatus: string | null, concerns: string[], rednessLatest: number) {
  const bs = (barrierStatus ?? "").toLowerCase();
  let base = 48;
  if (bs.includes("healthy")) base = 32;
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

async function getRecentLogs(profileId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.skinLog.findMany({
    where: { profileId, date: { gte: sevenDaysAgo } },
    orderBy: { date: "desc" },
    take: 50,
  });
}

export async function getSkinIdentitySnapshot(userId: string): Promise<SkinIdentitySnapshot> {
  const profile = await getOrCreateProfile(userId);
  const logs = await getRecentLogs(profile.id);

  const rednessLatest = clampInt(logs[0]?.rednessLevel ?? 0, 0, 5, 0);
  const rednessMax = clampInt(Math.max(0, ...logs.map((l) => l.rednessLevel ?? 0)), 0, 5, 0);

  const concerns = Array.isArray(profile.concerns) ? profile.concerns.slice(0, 12) : [];
  const sensitivity = inferSensitivity(profile.barrierStatus, concerns, rednessLatest);

  return {
    userId: profile.userId,
    skinType: profile.skinType,
    barrierStatus: profile.barrierStatus,
    concerns,
    status: profile.barrierStatus === "Healthy" && rednessLatest <= 1 ? "good" : "attention",
    resilienceScore: inferResilience(profile.barrierStatus, sensitivity),
    hydration: inferHydration(profile.skinType, profile.barrierStatus),
    sebum: inferSebum(profile.skinType),
    sensitivity,
    last7d: { rednessMax, rednessLatest },
  };
}

export async function setUserConcerns(userId: string, concerns: string[]) {
  const profile = await getOrCreateProfile(userId);
  const normalized = normalizeStringList(concerns, 12, 48);
  await prisma.userProfile.update({ where: { id: profile.id }, data: { concerns: { set: normalized } } });
  return getSkinIdentitySnapshot(userId);
}

export async function logSkinStatus(userId: string, data: SkinLogInput) {
  const profile = await getOrCreateProfile(userId);

  const rednessLevel = clampInt(data.rednessLevel, 0, 5, 0);
  const acneCount = clampInt(data.acneCount ?? 0, 0, 500, 0);
  const hydration = clampInt(data.hydration ?? 0, 0, 5, 0);

  const date = coerceDate(data.date);
  const targetProduct = normalizeOptionalString(data.targetProduct, 200);
  const sensation = normalizeOptionalString(data.sensation, 80);
  const notes = normalizeOptionalString(data.notes, 2000);

  return prisma.skinLog.create({
    data: {
      profileId: profile.id,
      ...(date ? { date } : {}),
      rednessLevel,
      acneCount,
      hydration,
      targetProduct,
      sensation,
      notes,
    },
  });
}

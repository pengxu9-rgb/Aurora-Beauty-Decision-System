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

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};

const normalizeOptionalString = (value: unknown, maxLen: number) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
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

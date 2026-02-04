import type {
  DupeMatch,
  MechanismKey,
  MechanismVector,
  Platform,
  PlatformWeights,
  RoutinePlan,
  RoutineStep,
  SkuScoreBreakdown,
  SkuVector,
  UserVector,
} from "@/types";

const MECHANISM_KEYS: MechanismKey[] = [
  "oil_control",
  "soothing",
  "repair",
  "redness",
  "acne_comedonal",
  "brightening",
];

const PLATFORMS: Platform[] = ["RED", "Ecommerce", "Reddit", "DermSources"];

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp100(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizePlatformWeights(weights: PlatformWeights): PlatformWeights {
  const cleaned: PlatformWeights = { RED: 0, Reddit: 0, Ecommerce: 0, DermSources: 0 };
  let sum = 0;

  for (const p of PLATFORMS) {
    const v = Math.max(0, weights[p] ?? 0);
    cleaned[p] = v;
    sum += v;
  }

  if (sum <= 0) {
    return { ...cleaned, RED: 0.5, Reddit: 0.5, Ecommerce: 0, DermSources: 0 };
  }

  for (const p of PLATFORMS) cleaned[p] = cleaned[p] / sum;
  return cleaned;
}

function calculateScienceScore(sku: SkuVector, user: UserVector) {
  const goals = user.goals ?? [];
  if (goals.length === 0) return 0;

  let weighted = 0;
  let weightSum = 0;

  for (const goal of goals) {
    const value = clamp01(sku.mechanism[goal.track] ?? 0);
    const weight = goal.priority > 0 ? 1 / goal.priority : 1;
    weighted += value * weight;
    weightSum += weight;
  }

  if (weightSum <= 0) return 0;
  return clamp100((weighted / weightSum) * 100);
}

function calculateSocialScore(sku: SkuVector, user: UserVector) {
  const weights = normalizePlatformWeights(user.platform_weights);
  const scores = sku.social_stats.platform_scores;

  let total = 0;
  for (const p of PLATFORMS) {
    total += clamp01(weights[p]) * clamp01(scores[p] ?? 0);
  }

  return clamp100(total * 100);
}

function calculateEngineeringScore(sku: SkuVector) {
  // Matches the prototype: usability_penalty is a “half penalty” (0.8 -> 60).
  const penalty = clamp01(sku.engineering?.usability_penalty ?? 0.5);
  return clamp100((1 - 0.5 * penalty) * 100);
}

function normalizeEnvStressEss(user: UserVector): number | null {
  let ess: unknown;
  try {
    ess = (user as any).env_stress?.ess;
  } catch {
    return null;
  }

  if (ess == null || typeof ess !== "number" || !Number.isFinite(ess)) return null;
  return clamp100(ess);
}

function computeEnvStressPenalty(user: UserVector) {
  const ess = normalizeEnvStressEss(user);
  if (ess == null) return 0;
  // Bounded penalty: 0..10 points. Keeps the original weight model intact while allowing
  // a conservative "stress-aware" score adjustment.
  return clamp100((ess / 100) * 10);
}

/**
 * calculateScore (Scoring Engine)
 * Total = 0.3 * ScienceScore + 0.6 * SocialScore + 0.1 * EngineeringScore
 * Total = Total - EnvStressPenalty (optional; max 10 points)
 *
 * VETO (Critical):
 * If user.barrier_status === 'impaired' AND (risk_flags includes 'high_irritation' OR burn_rate > 0.1),
 * Total score is forced to 0.
 */
export function calculateScore(sku: SkuVector, user: UserVector): SkuScoreBreakdown {
  const science = calculateScienceScore(sku, user);
  const social = calculateSocialScore(sku, user);
  const engineering = calculateEngineeringScore(sku);
  const envPenalty = computeEnvStressPenalty(user);

  const vetoed =
    user.barrier_status === "impaired" &&
    (sku.risk_flags.includes("high_irritation") || (sku.social_stats.burn_rate ?? 0) > 0.1);

  if (vetoed) {
    return {
      science,
      social,
      engineering,
      total: 0,
      vetoed: true,
      veto_reason:
        sku.risk_flags.includes("high_irritation")
          ? "VETO: barrier impaired + high_irritation risk flag."
          : "VETO: barrier impaired + burn_rate > 0.10.",
    };
  }

  const total = 0.3 * science + 0.6 * social + 0.1 * engineering;
  return { science, social, engineering, total: clamp100(total - envPenalty), vetoed: false };
}

function toDenseMechanismVector(vector: MechanismVector) {
  return MECHANISM_KEYS.map((k) => clamp01(vector[k] ?? 0));
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function buildTradeoffNote(anchor: SkuVector, candidate: SkuVector) {
  const notes: string[] = [];

  if (candidate.experience.texture === "sticky" || (candidate.experience.stickiness ?? 0) > 0.6) {
    notes.push("Texture is sticky.");
  }

  if ((candidate.experience.pilling_risk ?? 0) > 0.6) {
    notes.push("Higher pilling risk under layering.");
  }

  if (candidate.price < anchor.price) {
    notes.push("Lower price trade-off: expect fewer premium textures/finishes.");
  }

  return notes[0] ?? "Lower-cost alternative.";
}

/**
 * findDupes (Dupe Discovery Engine)
 * - Cosine similarity over mechanism vectors
 * - Cheaper-than-anchor filter
 */
export function findDupes(anchorSku: SkuVector, database: SkuVector[], limit = 3): DupeMatch[] {
  const anchor = toDenseMechanismVector(anchorSku.mechanism);

  return database
    .filter((sku) => sku.sku_id !== anchorSku.sku_id)
    .filter((sku) => sku.price < anchorSku.price)
    .map((sku) => {
      const similarity = cosineSimilarity(anchor, toDenseMechanismVector(sku.mechanism));
      return { sku, similarity, tradeoff_note: buildTradeoffNote(anchorSku, sku) } satisfies DupeMatch;
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export type RoutineValidation = {
  ok: boolean;
  conflicts: string[];
};

function extractSkusFromRoutine(plan: RoutinePlan): SkuVector[] {
  const steps: RoutineStep[] = [...plan.am, ...plan.pm];
  return steps.map((s) => s.sku);
}

/**
 * validateRoutine (Routine & Compatibility)
 * - Flags conflicts like "Copper Peptides" + "Vitamin C"
 */
export function validateRoutine(plan: RoutinePlan): RoutineValidation {
  const skus = extractSkusFromRoutine(plan);
  const actives = skus.flatMap((s) => s.actives ?? []);
  const haystack = actives.map((a) => a.toLowerCase());

  const hasCopper = haystack.some((a) => a.includes("copper peptides") || (a.includes("copper") && a.includes("peptide")));
  const hasVitC = haystack.some((a) => a.includes("vitamin c") || a.includes("ascorbic"));

  const conflicts: string[] = [];
  if (hasCopper && hasVitC) {
    conflicts.push("CONFLICT: Copper Peptides + Vitamin C in the same routine (separate AM/PM or alternate days).");
  }

  return { ok: conflicts.length === 0, conflicts };
}

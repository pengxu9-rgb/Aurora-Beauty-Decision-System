import type {
  DupeMatch,
  MechanismKey,
  MechanismVector,
  Platform,
  RoutinePlan,
  RoutineStep,
  SkuCategory,
  SkuScoreBreakdown,
  SkuVector,
  UserVector,
} from "./types";

const MECHANISM_KEYS: MechanismKey[] = [
  "oil_control",
  "soothing",
  "repair",
  "redness",
  "acne_comedonal",
  "brightening",
];

function clamp01(value: number) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp100(value: number) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizeWeights(weights: Partial<Record<Platform, number>>): Record<Platform, number> {
  const entries = (Object.entries(weights) as Array<[Platform, number]>)
    .map(([k, v]) => [k, typeof v === "number" ? v : 0] as const)
    .filter(([, v]) => v > 0);

  const sum = entries.reduce((acc, [, v]) => acc + v, 0);
  const base: Record<Platform, number> = { RED: 0, Reddit: 0, Ecommerce: 0, DermSources: 0 };

  if (sum <= 0) {
    // Default to an even split across the main two “social” sources.
    return { ...base, RED: 0.5, Reddit: 0.5 };
  }

  for (const [platform, value] of entries) base[platform] = value / sum;
  return base;
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
  const weights = normalizeWeights(user.platform_weights ?? {});
  const platformScores = sku.social_stats.platform_scores ?? {};

  let total = 0;
  for (const platform of Object.keys(weights) as Platform[]) {
    const w = weights[platform] ?? 0;
    const s = clamp01(platformScores[platform] ?? 0);
    total += w * s;
  }

  return clamp100(total * 100);
}

function calculateEngineeringScore(sku: SkuVector) {
  // Match the prototype feel: usability_penalty is a “half penalty” into a 0-100 score.
  const penalty = clamp01(sku.engineering?.usability_penalty ?? 0.5);
  return clamp100((1 - 0.5 * penalty) * 100);
}

export function calculateSkuScore(sku: SkuVector, user: UserVector): SkuScoreBreakdown {
  const science = calculateScienceScore(sku, user);
  const social = calculateSocialScore(sku, user);
  const engineering = calculateEngineeringScore(sku);

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
          ? "Barrier impaired + high irritation flag."
          : "Barrier impaired + burn rate > 0.10.",
    };
  }

  const total = 0.3 * science + 0.6 * social + 0.1 * engineering;
  return { science, social, engineering, total: clamp100(total), vetoed: false };
}

function toDenseVector(vector: MechanismVector) {
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

  if ((candidate.experience.stickiness ?? 0) > 0.6 || candidate.experience.texture === "sticky") {
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

export function findDupes(anchorSku: SkuVector, database: SkuVector[], limit = 3): DupeMatch[] {
  const anchorVec = toDenseVector(anchorSku.mechanism);

  const matches = database
    .filter((s) => s.sku_id !== anchorSku.sku_id)
    .filter((s) => s.price < anchorSku.price)
    .map((sku) => {
      const similarity = cosineSimilarity(anchorVec, toDenseVector(sku.mechanism));
      return { sku, similarity, tradeoff_note: buildTradeoffNote(anchorSku, sku) } satisfies DupeMatch;
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return matches;
}

function pickCheapest(candidates: Array<{ sku: SkuVector; score: SkuScoreBreakdown }>) {
  return [...candidates].sort((a, b) => a.sku.price - b.sku.price)[0]?.sku ?? null;
}

function pickBestScore(candidates: Array<{ sku: SkuVector; score: SkuScoreBreakdown }>) {
  return [...candidates].sort((a, b) => b.score.total - a.score.total)[0]?.sku ?? null;
}

function uniqueSkus(steps: RoutineStep[]) {
  const seen = new Set<string>();
  const out: SkuVector[] = [];
  for (const step of steps) {
    if (seen.has(step.sku.sku_id)) continue;
    seen.add(step.sku.sku_id);
    out.push(step.sku);
  }
  return out;
}

function hasActive(plan: RoutinePlan, active: string) {
  const needle = active.toLowerCase();
  const all = [...plan.am, ...plan.pm].flatMap((s) => s.sku.actives ?? []);
  return all.some((a) => a.toLowerCase().includes(needle));
}

export function generateRoutine(user: UserVector, recommendedSkus: SkuVector[]): RoutinePlan {
  const scored = recommendedSkus.map((sku) => ({ sku, score: calculateSkuScore(sku, user) }));

  const cleanser = pickCheapest(scored.filter((s) => s.sku.category === "cleanser"));
  const toner = pickCheapest(scored.filter((s) => s.sku.category === "toner"));

  const serum = pickBestScore(scored.filter((s) => s.sku.category === "serum"));
  const treatment = pickBestScore(scored.filter((s) => s.sku.category === "treatment"));
  const moisturizer = pickBestScore(scored.filter((s) => s.sku.category === "moisturizer"));
  const sunscreen = pickCheapest(scored.filter((s) => s.sku.category === "sunscreen"));

  const am: RoutineStep[] = [];
  const pm: RoutineStep[] = [];

  if (cleanser) {
    am.push({ step: "cleanser", sku: cleanser, notes: ["Low-budget, low-contact step."] });
    pm.push({ step: "cleanser", sku: cleanser });
  }

  if (toner) {
    am.push({ step: "toner", sku: toner });
    pm.push({ step: "toner", sku: toner });
  }

  if (serum) {
    am.push({ step: "serum", sku: serum, notes: ["High-efficacy step."] });
  }

  if (treatment) {
    pm.push({
      step: "treatment",
      sku: treatment,
      notes: ["Primary active step. Start 3-4x/week if sensitive."],
    });
  }

  if (moisturizer) {
    am.push({ step: "moisturizer", sku: moisturizer, notes: ["Barrier support."] });
    pm.push({ step: "moisturizer", sku: moisturizer });
  }

  if (sunscreen) {
    am.push({ step: "sunscreen", sku: sunscreen, notes: ["Non-negotiable for brightening."] });
  }

  const conflicts: string[] = [];
  const draft: RoutinePlan = { am, pm, estimated_total: 0, conflicts: [] };
  if (hasActive(draft, "copper peptides") && hasActive(draft, "vitamin c")) {
    conflicts.push("Copper peptides + Vitamin C in the same routine can conflict (separate AM/PM or alternate days).");
  }

  const estimated_total = uniqueSkus([...am, ...pm]).reduce((acc, sku) => acc + sku.price, 0);

  return { am, pm, estimated_total, conflicts };
}

export type AuroraRun = {
  user: UserVector;
  anchor: SkuVector;
  anchor_score: SkuScoreBreakdown;
  scored: Array<{ sku: SkuVector; score: SkuScoreBreakdown }>;
  dupes: DupeMatch[];
  routine: RoutinePlan;
};

export function runAurora(user: UserVector, db: SkuVector[], anchorSkuId: string): AuroraRun {
  const anchor = db.find((s) => s.sku_id === anchorSkuId) ?? db[0];
  if (!anchor) {
    throw new Error("Aurora DB is empty; cannot select an anchor SKU.");
  }

  const scored = db.map((sku) => ({ sku, score: calculateSkuScore(sku, user) }));
  const anchor_score = calculateSkuScore(anchor, user);
  const dupes = findDupes(anchor, db);
  const routine = generateRoutine(user, db);

  return { user, anchor, anchor_score, scored, dupes, routine };
}

export function formatCurrency(amount: number, currency: "USD" | "CNY") {
  const v = Math.round(amount * 100) / 100;
  if (currency === "CNY") return `¥${v}`;
  return `$${v}`;
}

export function humanizeCategory(category: SkuCategory) {
  switch (category) {
    case "cleanser":
      return "Cleanser";
    case "toner":
      return "Toner";
    case "treatment":
      return "Treatment";
    case "serum":
      return "Serum";
    case "moisturizer":
      return "Moisturizer";
    case "sunscreen":
      return "Sunscreen";
    default:
      return category;
  }
}

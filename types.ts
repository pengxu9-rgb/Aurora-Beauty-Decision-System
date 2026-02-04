export type Platform = "RED" | "Reddit" | "Ecommerce" | "DermSources";

export type SkinType = "oily" | "dry" | "combination" | "normal" | "sensitive";

export type BarrierStatus = "healthy" | "impaired";

export type BudgetStrategy = "high_low" | "balanced";

export type MechanismKey =
  | "oil_control"
  | "soothing"
  | "repair"
  | "redness"
  | "acne_comedonal"
  | "brightening";

export type SkuCategory = "cleanser" | "toner" | "treatment" | "serum" | "moisturizer" | "sunscreen";

export type RiskFlag = "alcohol" | "acid" | "high_irritation";

// Deep Matrix
export type MechanismVector = Record<MechanismKey, number>; // 0-1

export type ExperienceVector = {
  texture?: "watery" | "gel" | "lotion" | "cream" | "oil" | "sticky" | "thick";
  finish?: "matte" | "natural" | "dewy";
  pilling_risk?: number; // 0-1 (higher = worse)
  stickiness?: number; // 0-1 (higher = stickier)
};

export type EngineeringVector = {
  usability_penalty?: number; // 0-1 (higher = worse)
  stability_complexity?: number; // 0-1 (higher = harder to formulate)
  delivery_tech?: string[];
};

export type PlatformWeights = Record<Platform, number>; // 0-1 (auto-normalized in scoring)

export type SocialStats = {
  // Canonical representation (used by the engine)
  platform_scores: PlatformWeights; // 0-1

  // Convenience aliases (matches the Master Prompt wording)
  RED_score?: number; // 0-1
  Reddit_score?: number; // 0-1

  burn_rate?: number; // 0-1 (higher = more “burning/irritation” mentions)
  key_phrases?: Partial<Record<Platform, string[]>>;
};

export type UserGoal = { track: MechanismKey; priority: number };

export type Budget = {
  total_monthly: number;
  strategy: BudgetStrategy;
};

export type EnvStressContributorV1 = {
  key: string;
  weight?: number; // 0..1 (optional)
  note?: string;
};

export type EnvStressInputV1 = {
  schema_version: "aurora.env_stress.v1";
  profile: {
    skin_type?: string | null;
    barrier_status?: string | null;
    sensitivity?: string | null; // e.g. "low" | "medium" | "high"
    goals?: string[];
    region?: string | null; // e.g. "CN" | "US" | "EU" | null
  };
  recent_logs?: Array<{
    date: string; // YYYY-MM-DD
    redness?: number | null; // 0..5 or 0..100
    hydration?: number | null; // 0..5 or 0..100
    acne?: number | null; // 0..5 or 0..100
  }>;
  env?: Record<string, unknown>;
};

export type EnvStressOutputV1 = {
  schema_version: "aurora.env_stress.v1";
  ess: number | null; // 0..100; null if insufficient inputs
  tier: string | null; // "Low" | "Moderate" | "High" (report may refine)
  contributors: EnvStressContributorV1[];
  missing_inputs: string[];
  generated_at: string; // ISO timestamp
};

export type RadarDatumV1 = { axis: string; value: number }; // value: 0..100

export type EnvStressUiModelV1 = {
  schema_version: "aurora.ui.env_stress.v1";
  ess: number | null;
  tier: string | null;
  radar: RadarDatumV1[];
  notes: string[];
};

export type ConflictHeatmapUiModelV1 = {
  schema_version: "aurora.ui.conflict_heatmap.v1";
  // TODO(report): heatmap matrix definition (axes, buckets, and color rules)
};

export type UiRenderingConstraintsV1 = {
  schema_version: "aurora.ui.constraints.v1";
  value_range: "0..100";
  nan_policy: "clamp_to_0_and_warn";
  max_axes: 8;
  max_notes: 4;
};

export type UserVector = {
  skin_type: SkinType | SkinType[];
  barrier_status: BarrierStatus;
  budget: Budget;
  goals: UserGoal[];
  platform_weights: PlatformWeights;
  constraints?: string[];
  env_stress?: EnvStressOutputV1 | null;
};

export type SkuVector = {
  sku_id: string;
  name: string;
  brand: string;
  category: SkuCategory;
  price: number;
  currency: "USD" | "CNY";

  mechanism: MechanismVector;
  experience: ExperienceVector;
  risk_flags: RiskFlag[];
  social_stats: SocialStats;
  engineering?: EngineeringVector;

  actives?: string[];
  notes?: string[];
};

export type SkuScoreBreakdown = {
  science: number; // 0-100
  social: number; // 0-100
  engineering: number; // 0-100
  total: number; // 0-100
  vetoed: boolean;
  veto_reason?: string;
};

export type DupeMatch = {
  sku: SkuVector;
  similarity: number; // 0-1
  tradeoff_note: string;
};

export type RoutineStep = {
  step: SkuCategory;
  sku: SkuVector;
  notes?: string[];
};

export type RoutinePlan = {
  am: RoutineStep[];
  pm: RoutineStep[];
  estimated_total: number;
  conflicts: string[];
};

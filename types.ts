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

export type UserVector = {
  skin_type: SkinType | SkinType[];
  barrier_status: BarrierStatus;
  budget: Budget;
  goals: UserGoal[];
  platform_weights: PlatformWeights;
  constraints?: string[];
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


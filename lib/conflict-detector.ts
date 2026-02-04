export type ConflictDetectorInputV1 = {
  schema_version: "aurora.conflicts.v1";
  routine?: {
    am?: Array<Record<string, unknown>>;
    pm?: Array<Record<string, unknown>>;
  };
  test_product?: Record<string, unknown>;
};

export type ConflictDetectorOutputV1 = {
  schema_version: "aurora.conflicts.v1";
  safe: boolean;
  conflicts: Array<{
    severity: "warn" | "block";
    rule_id?: string;
    message: string;
    step_index?: number;
  }>;
  summary: string;
};

type Lang = "en-US" | "zh-CN" | "en" | "zh";

type ActiveSignals = {
  hasRetinoid: boolean;
  hasAha: boolean;
  hasBha: boolean;
  hasPha: boolean;
  hasBpo: boolean;
  hasVitC: boolean;
  hasCopperPeptides: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitActiveString(value: string): string[] {
  return value
    .split(/[|,;/\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return splitActiveString(value);
  return [];
}

function getFieldStrings(obj: Record<string, unknown>, key: string): string[] {
  const raw = obj[key];
  if (raw == null) return [];
  return extractStringList(raw);
}

function extractActivesFromEntity(entity: unknown): string[] {
  if (!isPlainObject(entity)) return [];

  const out: string[] = [];

  // Common keys in KB / derived docs.
  const directKeys = [
    "key_actives",
    "keyActives",
    "hero_actives",
    "heroActives",
    "actives",
    "actives_summary",
    "activesSummary",
    "highlights",
  ];
  for (const k of directKeys) out.push(...getFieldStrings(entity, k));

  // Nested: sku.*
  const sku = entity.sku;
  if (isPlainObject(sku)) {
    out.push(...getFieldStrings(sku, "key_actives"));
    out.push(...getFieldStrings(sku, "keyActives"));
    out.push(...getFieldStrings(sku, "actives"));
  }

  // Nested: evidence_pack.*
  const evidencePack = entity.evidence_pack;
  if (isPlainObject(evidencePack)) {
    out.push(...getFieldStrings(evidencePack, "keyActives"));
    out.push(...getFieldStrings(evidencePack, "key_actives"));
    out.push(...getFieldStrings(evidencePack, "hero_actives"));
    out.push(...getFieldStrings(evidencePack, "highlights"));
  }

  // Nested: ingredients.*
  const ingredients = entity.ingredients;
  if (isPlainObject(ingredients)) {
    out.push(...getFieldStrings(ingredients, "hero_actives"));
    out.push(...getFieldStrings(ingredients, "heroActives"));
    // Fall back to scanning the head INCI list if provided (best-effort; may be noisy).
    const head = ingredients.head;
    if (Array.isArray(head)) {
      for (const item of head) if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
  }

  // Fallback: allow matching from product name if no explicit actives were provided.
  if (!out.length) {
    const name = typeof entity.name === "string" ? entity.name.trim() : "";
    const display = typeof entity.display_name === "string" ? entity.display_name.trim() : "";
    if (name) out.push(name);
    if (display && display !== name) out.push(display);
  }

  const cleaned = out
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => splitActiveString(s));

  // Deduplicate while keeping order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of cleaned) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique;
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function hasAny(patterns: Array<string | RegExp>, token: string) {
  for (const p of patterns) {
    if (typeof p === "string") {
      if (token.includes(p)) return true;
    } else {
      if (p.test(token)) return true;
    }
  }
  return false;
}

function detectSignalsFromActives(actives: string[]): ActiveSignals {
  const tokens = actives.map(normalizeToken);

  const retinoidPatterns: Array<string | RegExp> = [
    "retinoid",
    "retinol",
    "retinal",
    "retinaldehyde",
    "tretinoin",
    "adapalene",
    "tazarotene",
    "维a",
    "维a类",
    "维a酸",
    "维甲酸",
    "视黄",
    "a醇",
    "a醛",
    "阿达帕林",
    /(?<![a-z])vit\s*a(?![a-z])/i,
  ];

  const ahaPatterns: Array<string | RegExp> = [
    "aha",
    "alpha hydroxy",
    "glycolic",
    "lactic",
    "mandelic",
    "malic",
    "citric acid",
    "果酸",
    "甘醇酸",
    "乳酸",
    "杏仁酸",
  ];

  const bhaPatterns: Array<string | RegExp> = ["bha", "beta hydroxy", "salicylic", "水杨酸"];

  const phaPatterns: Array<string | RegExp> = [
    "pha",
    "polyhydroxy",
    "gluconolactone",
    "lactobionic",
    "葡萄糖酸内酯",
    "乳糖酸",
  ];

  const bpoPatterns: Array<string | RegExp> = ["benzoyl peroxide", "bpo", "过氧化苯甲酰"];

  const vitCPatterns: Array<string | RegExp> = [
    "vitamin c",
    "l-ascorbic",
    "ascorbic",
    "ascorbate",
    "ascorbyl",
    "ethyl ascorbic",
    "3-o-ethyl",
    "vc",
    "维c",
    "左旋维c",
    "抗坏血酸",
  ];

  const copperPeptidePatterns: Array<string | RegExp> = [
    "copper peptide",
    "copper peptides",
    "copper tripeptide",
    "ghk-cu",
    "蓝铜肽",
    "铜肽",
  ];

  const hasRetinoid = tokens.some((t) => hasAny(retinoidPatterns, t));
  const hasAha = tokens.some((t) => hasAny(ahaPatterns, t));
  const hasBha = tokens.some((t) => hasAny(bhaPatterns, t));
  const hasPha = tokens.some((t) => hasAny(phaPatterns, t));
  const hasBpo = tokens.some((t) => hasAny(bpoPatterns, t));
  const hasVitC = tokens.some((t) => hasAny(vitCPatterns, t));
  const hasCopperPeptides = tokens.some((t) => hasAny(copperPeptidePatterns, t));

  return { hasRetinoid, hasAha, hasBha, hasPha, hasBpo, hasVitC, hasCopperPeptides };
}

function mergeSignals(a: ActiveSignals, b: ActiveSignals): ActiveSignals {
  return {
    hasRetinoid: a.hasRetinoid || b.hasRetinoid,
    hasAha: a.hasAha || b.hasAha,
    hasBha: a.hasBha || b.hasBha,
    hasPha: a.hasPha || b.hasPha,
    hasBpo: a.hasBpo || b.hasBpo,
    hasVitC: a.hasVitC || b.hasVitC,
    hasCopperPeptides: a.hasCopperPeptides || b.hasCopperPeptides,
  };
}

function t(lang: Lang | undefined, en: string, zh: string) {
  return lang === "zh" || lang === "zh-CN" ? zh : en;
}

export function simulateConflictsV1(
  input: ConflictDetectorInputV1,
  opts?: { lang?: Lang },
): ConflictDetectorOutputV1 {
  const lang = opts?.lang;

  const routine = input.routine ?? {};
  const am = Array.isArray(routine.am) ? routine.am : [];
  const pm = Array.isArray(routine.pm) ? routine.pm : [];
  const steps = [...am, ...pm];

  const routineActives = steps.flatMap((s) => extractActivesFromEntity(s));
  const testActives = extractActivesFromEntity(input.test_product);

  const routineSignals = detectSignalsFromActives(routineActives);
  const testSignals = detectSignalsFromActives(testActives);
  const combined = mergeSignals(routineSignals, testSignals);

  const conflicts: ConflictDetectorOutputV1["conflicts"] = [];

  const add = (c: ConflictDetectorOutputV1["conflicts"][number]) => {
    if (conflicts.some((x) => x.rule_id && x.rule_id === c.rule_id)) return;
    conflicts.push(c);
  };

  const exfoliantKinds = Number(combined.hasAha) + Number(combined.hasBha) + Number(combined.hasPha);
  const hasAnyAcid = combined.hasAha || combined.hasBha || combined.hasPha;

  if (combined.hasRetinoid && combined.hasBpo) {
    add({
      severity: "block",
      rule_id: "retinoid_x_bpo",
      message: t(
        lang,
        "Retinoids + benzoyl peroxide in the same routine is a high irritation risk. Avoid stacking; alternate nights or separate AM/PM.",
        "维A类 + 过氧化苯甲酰（BPO）同一个流程/同晚叠加刺激风险很高；建议不要同晚叠加，改为错开（隔天/分早晚）。",
      ),
    });
  }

  if (combined.hasRetinoid && hasAnyAcid) {
    add({
      severity: "warn",
      rule_id: "retinoid_x_acids",
      message: t(
        lang,
        "Retinoids + exfoliating acids (AHA/BHA/PHA) can increase stinging/dryness when stacked. Prefer separating nights and ramping slowly.",
        "维A类 + 去角质酸（AHA/BHA/PHA）叠加更容易刺痛/爆皮；更安全的做法是错开晚用，并从低频开始逐步加量。",
      ),
    });
  }

  if (exfoliantKinds >= 2) {
    add({
      severity: "warn",
      rule_id: "multiple_exfoliants",
      message: t(
        lang,
        "Multiple exfoliants detected (AHA/BHA/PHA). Stacking can over-exfoliate; pick one or alternate days.",
        "检测到多种去角质酸（AHA/BHA/PHA）同时出现；叠加容易过度去角质，建议选一个或隔天交替。",
      ),
    });
  }

  if (combined.hasCopperPeptides && combined.hasVitC) {
    add({
      severity: "warn",
      rule_id: "copper_peptides_x_vitc",
      message: t(
        lang,
        "Copper peptides + strong vitamin C may be incompatible for some routines. Separate AM/PM or alternate days if you notice irritation.",
        "蓝铜肽/铜肽与高强度维C可能不兼容；如果出现刺痛/不适，建议错开（AM/PM 或隔天）。",
      ),
    });
  }

  const safe = conflicts.length === 0;

  const summary = (() => {
    if (!steps.length && !input.test_product) {
      return t(lang, "No routine provided; nothing to check yet.", "未提供流程信息：暂时无法做冲突检测。");
    }
    if (safe) {
      if (!routineActives.length && !testActives.length) {
        return t(
          lang,
          "No actives detected from provided data (check may be incomplete).",
          "未从现有数据中识别到活性信息（检测可能不完整）。",
        );
      }
      return t(lang, "No conflicts detected.", "未发现明显冲突。");
    }
    const blocks = conflicts.filter((c) => c.severity === "block").length;
    return t(
      lang,
      `Needs attention: ${conflicts.length} issue(s) (${blocks} block).`,
      `需要注意：共 ${conflicts.length} 条提示（${blocks} 条为阻断级）。`,
    );
  })();

  return { schema_version: "aurora.conflicts.v1", safe, conflicts, summary };
}


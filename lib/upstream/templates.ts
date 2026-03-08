import { extractJsonObject, extractJsonObjectByKeys, isPlainObject, parseJsonOnlyObject } from "./json.ts";
import type {
  SupportedTemplateId,
  TemplateDefinition,
  TemplateValidationFailureReason,
  TemplateValidationResult,
  UpstreamChatRequest,
  UpstreamTemplateId,
} from "./types.ts";

const ROUTINE_FIT_REQUIRED_KEYS = [
  "overall_fit",
  "fit_score",
  "summary",
  "highlights",
  "concerns",
  "dimension_scores",
  "next_questions",
];

const ROUTINE_FIT_DIMENSION_KEYS = [
  "ingredient_match",
  "routine_completeness",
  "conflict_risk",
  "sensitivity_safety",
];

const RECO_MAIN_EMPTY_TASK_MODE_HINTS = [
  "ingredient_",
  "no_candidate",
  "no_candidates",
];

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readString(item)).filter(Boolean);
}

function readObject(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function failure(
  failure_reason: TemplateValidationFailureReason,
  missing_keys: string[] = [],
  value: Record<string, unknown> | null = null,
  partial_structured = false,
): TemplateValidationResult {
  return { ok: false, value, failure_reason, missing_keys, partial_structured };
}

function success(value: Record<string, unknown>, partial_structured = false): TemplateValidationResult {
  return { ok: true, value, failure_reason: null, missing_keys: [], partial_structured };
}

function buildJsonOnlyRetryPrompt({
  prompt,
  schemaSummary,
  missing_keys,
  failure_reason,
}: {
  prompt: string;
  schemaSummary: string;
  missing_keys: string[];
  failure_reason: TemplateValidationFailureReason;
}) {
  const missingClause = missing_keys.length ? `Missing keys: ${missing_keys.join(", ")}.` : `Failure reason: ${failure_reason}.`;
  return `${prompt.trim()}\n\n[SYSTEM]\nRetry. Return exactly one JSON object only.\n${missingClause}\nOutput contract:\n${schemaSummary}\nDo not add markdown. Do not add commentary. Do not ask clarifying questions.\n[/SYSTEM]`;
}

function validateRoutineFit(candidate: Record<string, unknown> | null, request: UpstreamChatRequest): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  if (request.disallow_clarify) {
    const intent = String(candidate.intent || "").trim().toLowerCase();
    if (intent === "clarify" || isPlainObject(candidate.clarification)) return failure("clarify_like_response", [], candidate);
  }
  const missingTopLevel = ROUTINE_FIT_REQUIRED_KEYS.filter((key) => candidate[key] == null);
  const dimensionScores = isPlainObject(candidate.dimension_scores) ? candidate.dimension_scores : null;
  const missingDimensions = ROUTINE_FIT_DIMENSION_KEYS.filter((key) => !isPlainObject(dimensionScores?.[key]));
  if (missingTopLevel.length || missingDimensions.length) {
    return failure(
      "missing_required_keys",
      [...missingTopLevel, ...missingDimensions.map((key) => `dimension_scores.${key}`)],
      candidate,
      Boolean(dimensionScores && missingDimensions.length > 0),
    );
  }
  return success(candidate);
}

function validateAlternatives(candidate: Record<string, unknown> | null): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  if (!Array.isArray(candidate.alternatives)) {
    return failure("missing_required_keys", ["alternatives"], candidate);
  }
  return success(candidate);
}

function getRecoMainTaskMode(candidate: Record<string, unknown>) {
  const recommendationMeta = readObject(candidate.recommendation_meta);
  const metadata = readObject(candidate.metadata);
  return (
    readString(candidate.task_mode) ||
    readString((candidate as Record<string, unknown>).taskMode) ||
    readString(recommendationMeta?.task_mode) ||
    readString((recommendationMeta as Record<string, unknown> | null)?.taskMode) ||
    readString(metadata?.task_mode) ||
    readString((metadata as Record<string, unknown> | null)?.taskMode)
  ).toLowerCase();
}

function isExplicitRecoEmptyMode(candidate: Record<string, unknown>) {
  const taskMode = getRecoMainTaskMode(candidate);
  if (!taskMode) return false;
  const modeAllowsEmpty = RECO_MAIN_EMPTY_TASK_MODE_HINTS.some((token) => taskMode.includes(token));
  if (!modeAllowsEmpty) return false;

  const missingInfo = readStringArray(candidate.missing_info);
  const warnings = readStringArray(candidate.warnings);
  const failureReason = readString(candidate.failure_reason);
  const productsEmptyReason = readString(candidate.products_empty_reason);
  const taskWarnings = readStringArray(readObject(candidate.metadata)?.warnings);
  const constraintSummary = readObject(candidate.constraint_match_summary);
  const matchedCount = Number((constraintSummary && constraintSummary.matched) ?? NaN);

  return Boolean(
    failureReason ||
      productsEmptyReason ||
      missingInfo.length > 0 ||
      warnings.length > 0 ||
      taskWarnings.length > 0 ||
      (Number.isFinite(matchedCount) && matchedCount === 0),
  );
}

function readRecoIdentity(item: Record<string, unknown>) {
  const sku = readObject(item.sku) || readObject(item.product);
  return (
    readString(item.name) ||
    readString(item.display_name) ||
    readString((item as Record<string, unknown>).displayName) ||
    readString(sku?.name) ||
    readString(sku?.display_name) ||
    readString((sku as Record<string, unknown> | null)?.displayName) ||
    readString(item.product_id) ||
    readString((item as Record<string, unknown>).productId) ||
    readString(item.sku_id) ||
    readString((item as Record<string, unknown>).skuId)
  );
}

function readRecoReasons(item: Record<string, unknown>) {
  return [
    ...readStringArray(item.reasons),
    ...readStringArray(item.why),
    ...readStringArray(item.why_candidate),
    ...readStringArray(item.notes),
    ...readStringArray(readObject(item.evidence_pack)?.pairingRules),
    ...readStringArray(readObject(item.evidence_pack)?.keyActives),
    ...readStringArray(readObject(item.evidence_pack)?.sensitivityFlags),
    ...readStringArray(item.warnings),
    ...readStringArray(item.missing_info),
    ...readStringArray(item.missingInfo),
    ...[readString(item.reason), readString(item.why)],
  ].filter(Boolean);
}

function validateRecoMain(candidate: Record<string, unknown> | null): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  const recommendations = Array.isArray(candidate.recommendations) ? candidate.recommendations : null;
  if (!recommendations) {
    return failure("missing_required_keys", ["recommendations"], candidate);
  }
  if (recommendations.length === 0) {
    if (isExplicitRecoEmptyMode(candidate)) {
      return success(candidate, true);
    }
    return failure("empty_recommendations_rejected", ["recommendations"], candidate);
  }

  const missingKeys: string[] = [];
  recommendations.forEach((row, index) => {
    const item = readObject(row);
    if (!item) {
      missingKeys.push(`recommendations[${index}]`);
      return;
    }
    if (!readRecoIdentity(item)) {
      missingKeys.push(`recommendations[${index}].identity`);
    }
    if (!readRecoReasons(item).length) {
      missingKeys.push(`recommendations[${index}].reasons`);
    }
  });
  if (missingKeys.length) {
    return failure("missing_required_keys", missingKeys, candidate, true);
  }
  return success(candidate);
}

function validateDupeParse(candidate: Record<string, unknown> | null): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  const parseObj = isPlainObject(candidate.parse) ? candidate.parse : null;
  const product =
    (isPlainObject(candidate.product) ? candidate.product : null) ||
    (parseObj && (isPlainObject(parseObj.anchor_product) ? parseObj.anchor_product : isPlainObject(parseObj.anchorProduct) ? parseObj.anchorProduct : null));
  if (!product) {
    return failure("missing_required_keys", ["product"], candidate);
  }
  return success(candidate);
}

function validateDupeCompare(candidate: Record<string, unknown> | null): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  const ok =
    Array.isArray(candidate.tradeoffs) ||
    isPlainObject(candidate.tradeoffs_detail) ||
    isPlainObject(candidate.tradeoffsDetail) ||
    isPlainObject(candidate.evidence) ||
    isPlainObject(candidate.original) ||
    isPlainObject(candidate.dupe) ||
    Array.isArray(candidate.alternatives) ||
    isPlainObject(candidate.compare);
  if (!ok) {
    return failure("missing_required_keys", ["tradeoffs_or_compare_payload"], candidate);
  }
  return success(candidate);
}

const TEMPLATE_MAP: Record<string, TemplateDefinition> = {
  routine_fit_summary_v1: {
    template_id: "routine_fit_summary_v1",
    intent: "routine_fit_summary",
    required_keys: ROUTINE_FIT_REQUIRED_KEYS,
    validate: validateRoutineFit,
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary:
          '{ "overall_fit":"good_match|partial_match|needs_adjustment", "fit_score":0.0, "summary":"", "highlights":[""], "concerns":[""], "dimension_scores":{"ingredient_match":{"score":0.0,"note":""},"routine_completeness":{"score":0.0,"note":""},"conflict_risk":{"score":0.0,"note":""},"sensitivity_safety":{"score":0.0,"note":""}}, "next_questions":[""] }',
      }),
  },
  reco_alternatives_v1_0: {
    template_id: "reco_alternatives_v1_0",
    intent: "alternatives",
    required_keys: ["alternatives"],
    validate: (candidate) => validateAlternatives(candidate),
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary: '{ "alternatives":[{"id":"","name":"","brand":"","why_candidate":[""],"tradeoffs":[""]}] }',
      }),
  },
  reco_main_v1_0: {
    template_id: "reco_main_v1_0",
    intent: "reco_products",
    required_keys: ["recommendations"],
    validate: (candidate) => validateRecoMain(candidate),
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary:
          '{ "recommendations":[{"name":"","why":[""],"slot":"AM|PM|ANY","sku":{"brand":"","name":"","sku_id":"","product_id":""}}], "missing_info":[""], "warnings":[""], "metadata":{"task_mode":"goal_based_products|ingredient_filtered_products|ingredient_lookup_no_candidates"} }\nGeneric reco mode MUST return at least 1 grounded recommendation. If there is no grounded candidate, do not return an empty success object. Only explicit ingredient/no-candidate mode may return recommendations: [].',
      }),
  },
  dupe_suggest_parse: {
    template_id: "dupe_suggest_parse",
    intent: "product_parse",
    required_keys: ["product"],
    validate: (candidate) => validateDupeParse(candidate),
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary: '{ "product":{"product_id":"","brand":"","name":"","display_name":""}, "confidence":0.0, "missing_info":[""] }',
      }),
  },
  dupe_compare_parse: {
    template_id: "dupe_compare_parse",
    intent: "product_parse",
    required_keys: ["product"],
    validate: (candidate) => validateDupeParse(candidate),
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary: '{ "product":{"product_id":"","brand":"","name":"","display_name":""}, "confidence":0.0, "missing_info":[""] }',
      }),
  },
  dupe_compare_main: {
    template_id: "dupe_compare_main",
    intent: "dupe_compare",
    required_keys: ["original", "dupe"],
    validate: (candidate) => validateDupeCompare(candidate),
    buildRetryPrompt: ({ prompt, missing_keys, failure_reason }) =>
      buildJsonOnlyRetryPrompt({
        prompt,
        missing_keys,
        failure_reason,
        schemaSummary: '{ "original":{}, "dupe":{}, "tradeoffs":[""], "evidence":{}, "confidence":0.0, "missing_info":[""] }',
      }),
  },
};

export function listSupportedTemplateIds(): SupportedTemplateId[] {
  return Object.keys(TEMPLATE_MAP) as SupportedTemplateId[];
}

export function resolveTemplateDefinition(templateId: UpstreamTemplateId) {
  if (!templateId) return null;
  return TEMPLATE_MAP[templateId] || null;
}

export function validateRequiredKeysObject(candidate: Record<string, unknown> | null, requiredKeys: string[]) {
  if (!candidate) return failure("json_parse_failed");
  const missing = requiredKeys.filter((key) => candidate[key] == null);
  if (missing.length) return failure("missing_required_keys", missing, candidate);
  return success(candidate);
}

export function parseCandidateFromText(text: string, requiredKeys: string[]) {
  return (
    extractJsonObjectByKeys(text, requiredKeys) ||
    parseJsonOnlyObject(text) ||
    extractJsonObject(text)
  );
}

import { extractJsonObject, extractJsonObjectByKeys, isPlainObject, parseJsonOnlyObject } from "./json.ts";
import type {
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

function validateRecoMain(candidate: Record<string, unknown> | null): TemplateValidationResult {
  if (!candidate) return failure("json_parse_failed");
  if (Array.isArray(candidate.recommendations) || isPlainObject(candidate.context) || isPlainObject(candidate.routine)) {
    return success(candidate);
  }
  return success(candidate, true);
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
        schemaSummary: '{ "recommendations":[{"name":"","why":[""],"slot":"AM|PM|ANY"}], "metadata":{} }',
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

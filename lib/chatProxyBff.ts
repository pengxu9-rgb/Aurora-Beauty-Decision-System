export type ProxyLanguage = "EN" | "CN";

export type ProxyFailureMode = "fallback" | "strict" | "retry";

export type ProxyChatResponse = {
  error?: string;
  answer?: string;
  bff_request_id?: string | null;
  bff_trace_id?: string | null;
  cards?: Array<Record<string, unknown>>;
  suggested_chips?: Array<Record<string, unknown>>;
  session_patch?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
};

type BffEnvelopeLike = {
  request_id?: unknown;
  trace_id?: unknown;
  assistant_message?: { content?: unknown } | null;
  cards?: unknown;
  suggested_chips?: unknown;
  session_patch?: unknown;
  events?: unknown;
};

type BffChatReqInput = {
  message?: string | null;
  messages?: Array<{ role: string; content: string }>;
  actionId?: string | null;
  actionLabel?: string | null;
  actionData?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
  language?: ProxyLanguage;
  anchorProductId?: string | null;
  anchorProductUrl?: string | null;
  clientState?: string | null;
  debug?: boolean;
};

const CORE_PROFILE_FIELDS = ["skinType", "sensitivity", "barrierStatus", "goals"] as const;

function asNonEmptyString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeActionKind(actionId: string): "chip" | "action" {
  const id = String(actionId || "").trim().toLowerCase();
  if (!id) return "action";
  if (id.startsWith("chip.") || id.startsWith("profile.") || id.startsWith("chip_")) return "chip";
  return "action";
}

export function normalizeProxyLanguage(input: unknown, fallback: ProxyLanguage = "EN"): ProxyLanguage {
  const raw = String(input || "")
    .trim()
    .toUpperCase();
  if (!raw) return fallback;
  if (raw === "CN" || raw === "ZH" || raw === "ZH-CN" || raw === "ZH_HANS") return "CN";
  return "EN";
}

export function normalizeProxyFailureMode(input: unknown): ProxyFailureMode {
  const raw = String(input || "")
    .trim()
    .toLowerCase();
  if (raw === "strict" || raw === "error") return "strict";
  if (raw === "retry") return "retry";
  return "fallback";
}

export function mapClientReqToBffChatReq(input: BffChatReqInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const message = asNonEmptyString(input.message);
  if (message) payload.message = message;

  const messages = Array.isArray(input.messages)
    ? input.messages
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const role = asNonEmptyString(item.role);
          const content = asNonEmptyString(item.content);
          if (!role || !content) return null;
          return { role, content };
        })
        .filter(Boolean)
    : [];
  if (messages.length) payload.messages = messages;

  const actionId = asNonEmptyString(input.actionId);
  const actionLabel = asNonEmptyString(input.actionLabel);
  const actionData = isPlainObject(input.actionData) ? input.actionData : null;
  if (actionId) {
    payload.action = {
      action_id: actionId,
      kind: normalizeActionKind(actionId),
      ...(actionData ? { data: actionData } : {}),
    };
  } else if (actionLabel) {
    payload.action = actionLabel;
  }

  if (isPlainObject(input.session)) payload.session = input.session;

  const language = normalizeProxyLanguage(input.language, "EN");
  payload.language = language;

  const anchorProductId = asNonEmptyString(input.anchorProductId);
  if (anchorProductId) payload.anchor_product_id = anchorProductId;
  const anchorProductUrl = asNonEmptyString(input.anchorProductUrl);
  if (anchorProductUrl) payload.anchor_product_url = anchorProductUrl;
  const clientState = asNonEmptyString(input.clientState);
  if (clientState) payload.client_state = clientState;
  if (input.debug === true) payload.debug = true;

  return payload;
}

export function mapBffEnvelopeToChatProxyResponse(input: BffEnvelopeLike, fallbackTraceId: string): ProxyChatResponse {
  const requestId = asNonEmptyString(input && input.request_id) || `chatproxy_${Date.now()}`;
  const traceId = asNonEmptyString(input && input.trace_id) || asNonEmptyString(fallbackTraceId) || `trace_${Date.now()}`;
  const answer =
    input &&
    input.assistant_message &&
    typeof input.assistant_message === "object" &&
    asNonEmptyString(input.assistant_message.content)
      ? asNonEmptyString(input.assistant_message.content) || ""
      : "";

  const cards = Array.isArray(input && input.cards)
    ? (input.cards as unknown[]).filter((item) => isPlainObject(item)).map((item) => item as Record<string, unknown>)
    : [];
  const suggestedChips = Array.isArray(input && input.suggested_chips)
    ? (input.suggested_chips as unknown[]).filter((item) => isPlainObject(item)).map((item) => item as Record<string, unknown>)
    : [];
  const sessionPatch = isPlainObject(input && input.session_patch) ? (input.session_patch as Record<string, unknown>) : {};
  const events = Array.isArray(input && input.events)
    ? (input.events as unknown[]).filter((item) => isPlainObject(item)).map((item) => item as Record<string, unknown>)
    : [];

  return {
    answer,
    bff_request_id: requestId,
    bff_trace_id: traceId,
    cards,
    suggested_chips: suggestedChips,
    session_patch: sessionPatch,
    events,
  };
}

export function buildProxyFallbackResponse({
  language,
  requestId,
  traceId,
  reasonCode,
  reason,
}: {
  language: ProxyLanguage;
  requestId: string;
  traceId: string;
  reasonCode: string;
  reason?: string;
}): ProxyChatResponse {
  const lang = normalizeProxyLanguage(language, "EN");
  const answer =
    lang === "CN"
      ? "当前系统连接不稳定，我先给你保守模式建议。请先完成基础肤质信息或稍后重试，我会继续保持非医疗边界。"
      : "The system connection is unstable right now, so I’m switching to a conservative mode. Complete your core skin profile or retry shortly, and I’ll stay within non-medical guidance.";

  const detail = asNonEmptyString(reason);
  const confidenceMessage =
    lang === "CN"
      ? "当前处于保守降级模式：本轮不输出激进推荐，请先补充诊断信息或重试。"
      : "Conservative fallback mode is active: no aggressive recommendations this turn. Please complete diagnosis inputs or retry.";

  return {
    answer,
    bff_request_id: requestId,
    bff_trace_id: traceId,
    cards: [
      {
        card_id: `conf_${requestId}`,
        type: "confidence_notice",
        payload: {
          reason: "proxy_fallback",
          severity: "warn",
          message: confidenceMessage,
          confidence: { score: 0, level: "low", rationale: ["proxy_fallback"] },
          actions: ["retry_chat", "start_diagnosis_gate"],
          ...(detail ? { details: [detail] } : {}),
        },
      },
      {
        card_id: `diag_${requestId}`,
        type: "diagnosis_gate",
        payload: {
          reason: "proxy_fallback",
          missing_fields: [...CORE_PROFILE_FIELDS],
          wants: "recommendation",
          profile: null,
          recent_logs: [],
        },
      },
    ],
    suggested_chips: [],
    session_patch: {},
    events: [
      {
        type: "proxy_fallback",
        proxy_fallback: true,
        reason_code: reasonCode,
        ...(detail ? { reason: detail } : {}),
      },
    ],
  };
}

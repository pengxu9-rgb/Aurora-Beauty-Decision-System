export type AuroraLang = "EN" | "CN";

export type FieldMissing = {
  field: string;
  reason: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  format?: "text" | "markdown";
};

export type SuggestedChip = {
  chip_id: string;
  label: string;
  kind?: "quick_reply" | "action";
  data?: Record<string, unknown>;
};

export type BffCard = {
  card_id: string;
  type: string;
  title?: string;
  payload: Record<string, unknown>;
  field_missing?: FieldMissing[];
};

export type BffEnvelope = {
  request_id: string;
  trace_id: string;
  assistant_message: AssistantMessage | null;
  suggested_chips: SuggestedChip[];
  cards: BffCard[];
  session_patch: Record<string, unknown>;
  events: Record<string, unknown>[];
};

export type RecoBlockName = "competitors" | "dupes" | "related_products";

export type RecoEmployeeFeedbackType = "relevant" | "not_relevant" | "wrong_block";

export type RecoEmployeeFeedbackPayload = {
  anchor_product_id: string;
  block: RecoBlockName;
  candidate_product_id?: string;
  candidate_name?: string;
  feedback_type: RecoEmployeeFeedbackType;
  wrong_block_target?: RecoBlockName;
  reason_tags?: string[];
  was_exploration_slot?: boolean;
  rank_position?: number;
  pipeline_version?: string;
  models?: string | Record<string, unknown>;
  suggestion_id?: string;
  llm_suggested_label?: RecoEmployeeFeedbackType;
  llm_confidence?: number;
  request_id?: string;
  session_id?: string;
  timestamp?: number;
};

export type RecoInterleaveClickPayload = {
  anchor_product_id: string;
  block: RecoBlockName;
  candidate_product_id?: string;
  candidate_name?: string;
  request_id: string;
  session_id: string;
  pipeline_version?: string;
  models?: string | Record<string, unknown>;
  category_bucket?: string;
  price_band?: string;
  timestamp?: number;
};

export type RecoAsyncUpdatesResponse = {
  ok: boolean;
  version?: number;
  has_update?: boolean;
  expires_at_ms?: number;
  payload_patch?: Record<string, unknown>;
  reason?: string;
  error?: string;
};

const DEFAULT_PIVOTA_AGENT_BASE_URL = "https://pivota-agent-production.up.railway.app";

export function getPivotaAgentBaseUrl() {
  const raw =
    process.env.PIVOTA_AGENT_URL?.trim() ||
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
    DEFAULT_PIVOTA_AGENT_BASE_URL;
  return raw.replace(/\/$/, "");
}

export function normalizeAuroraLang(raw: unknown): AuroraLang {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (v === "CN" || v === "ZH" || v === "ZH-CN" || v === "ZH_HANS") return "CN";
  return "EN";
}

function isFormDataBody(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function isBodyInitLike(value: unknown): value is BodyInit {
  if (value == null) return false;
  if (typeof value === "string") return true;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
  if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return true;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return true;
  return false;
}

export async function bffRequest<T>(
  path: string,
  opts: {
    uid: string;
    lang?: AuroraLang;
    traceId?: string;
    briefId?: string;
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<T> {
  const base = getPivotaAgentBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const hasRequestBody = method !== "GET" && method !== "HEAD";
  const bodyIsFormData = isFormDataBody(opts.body);

  let requestBody: BodyInit | undefined;
  if (hasRequestBody) {
    if (opts.body === undefined) requestBody = JSON.stringify({});
    else if (bodyIsFormData || isBodyInitLike(opts.body)) requestBody = opts.body as BodyInit;
    else requestBody = JSON.stringify(opts.body);
  }

  const headers: Record<string, string> = {
    "X-Aurora-UID": opts.uid,
    ...(opts.headers ?? {}),
  };
  if (opts.traceId) headers["X-Trace-ID"] = opts.traceId;
  if (opts.briefId) headers["X-Brief-ID"] = opts.briefId;
  if (opts.lang) headers["X-Lang"] = opts.lang;

  if (hasRequestBody && !bodyIsFormData && !isBodyInitLike(opts.body)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  } else if (hasRequestBody && typeof opts.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(requestBody !== undefined ? { body: requestBody } : {}),
    signal: opts.signal,
  });

  const json = (await res.json().catch(() => null)) as T | null;
  if (res.ok && json) return json;

  const msg = json && typeof json === "object" && "error" in (json as any) ? String((json as any).error) : "";
  throw new Error(msg || `Request failed (${res.status})`);
}

export async function postRecoEmployeeFeedback(
  payload: RecoEmployeeFeedbackPayload,
  opts: {
    uid: string;
    lang?: AuroraLang;
    traceId?: string;
    briefId?: string;
    signal?: AbortSignal;
  },
) {
  return bffRequest<{ ok: boolean; event?: Record<string, unknown> }>("/v1/reco/employee-feedback", {
    ...opts,
    method: "POST",
    body: payload,
  });
}

export async function postRecoInterleaveClick(
  payload: RecoInterleaveClickPayload,
  opts: {
    uid: string;
    lang?: AuroraLang;
    traceId?: string;
    briefId?: string;
    signal?: AbortSignal;
  },
) {
  return bffRequest<{ ok: boolean; attribution?: string; was_exploration_slot?: boolean; rank_position?: number }>(
    "/v1/reco/interleave/click",
    {
      ...opts,
      method: "POST",
      body: payload,
    },
  );
}

export async function getRecoAsyncUpdates(
  params: { ticket_id: string; since_version?: number },
  opts: {
    uid: string;
    lang?: AuroraLang;
    traceId?: string;
    briefId?: string;
    signal?: AbortSignal;
  },
) {
  const qp = new URLSearchParams();
  qp.set("ticket_id", params.ticket_id);
  if (typeof params.since_version === "number" && Number.isFinite(params.since_version)) {
    qp.set("since_version", String(Math.max(0, Math.trunc(params.since_version))));
  }
  return bffRequest<RecoAsyncUpdatesResponse>(`/v1/reco/async-updates?${qp.toString()}`, {
    ...opts,
    method: "GET",
  });
}

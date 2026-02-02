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

const DEFAULT_PIVOTA_AGENT_BASE_URL = "https://pivota-agent-production.up.railway.app";

export function getPivotaAgentBaseUrl() {
  const raw =
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
    process.env.PIVOTA_AGENT_URL?.trim() ||
    DEFAULT_PIVOTA_AGENT_BASE_URL;
  return raw.replace(/\/$/, "");
}

export function normalizeAuroraLang(raw: unknown): AuroraLang {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (v === "CN" || v === "ZH" || v === "ZH-CN" || v === "ZH_HANS") return "CN";
  return "EN";
}

export async function bffRequest<T>(
  path: string,
  opts: {
    uid: string;
    lang?: AuroraLang;
    traceId?: string;
    briefId?: string;
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  const base = getPivotaAgentBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Aurora-UID": opts.uid,
  };
  if (opts.traceId) headers["X-Trace-ID"] = opts.traceId;
  if (opts.briefId) headers["X-Brief-ID"] = opts.briefId;
  if (opts.lang) headers["X-Lang"] = opts.lang;

  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const res = await fetch(url, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    signal: opts.signal,
  });

  const json = (await res.json().catch(() => null)) as T | null;
  if (res.ok && json) return json;

  const msg = json && typeof json === "object" && "error" in (json as any) ? String((json as any).error) : "";
  throw new Error(msg || `Request failed (${res.status})`);
}


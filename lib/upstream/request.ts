import type { SupportedProvider, UpstreamChatRequest, UpstreamTemplateId } from "./types.ts";

function asNonEmptyString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeProvider(value: unknown): SupportedProvider | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "gemini" || raw === "openai") return raw;
  return null;
}

function normalizeTemplateId(value: unknown): UpstreamTemplateId {
  const raw = asNonEmptyString(value);
  return raw ? (raw as UpstreamTemplateId) : null;
}

function extractMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const role = asNonEmptyString((item as Record<string, unknown>).role);
      const content = asNonEmptyString((item as Record<string, unknown>).content);
      if (!role || !content) return null;
      return { role, content };
    })
    .filter((item): item is { role: string; content: string } => Boolean(item));
}

function derivePrompt(body: Record<string, unknown>, messages: Array<{ role: string; content: string }>) {
  const direct = asNonEmptyString(body.query) || asNonEmptyString(body.message);
  if (direct) return direct;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index];
    if (row.role === "user" && row.content.trim()) return row.content.trim();
  }
  return "";
}

function headerString(req: Request, name: string) {
  return asNonEmptyString(req.headers.get(name));
}

export function parseUpstreamChatRequest(req: Request, body: unknown):
  | { ok: true; value: UpstreamChatRequest }
  | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;
  const messages = extractMessages(obj.messages);
  const prompt = derivePrompt(obj, messages);
  if (!prompt) {
    return { ok: false, status: 400, error: "`query` (or `message`) is required" };
  }

  const promptTemplateId = normalizeTemplateId(obj.prompt_template_id) || normalizeTemplateId(headerString(req, "x-prompt-template"));
  const promptHash = asNonEmptyString(obj.prompt_hash) || headerString(req, "x-prompt-hash");
  const parentTraceId = asNonEmptyString(obj.parent_trace_id) || headerString(req, "x-parent-trace-id");
  const parentRequestId = asNonEmptyString(obj.parent_request_id) || headerString(req, "x-parent-request-id");

  return {
    ok: true,
    value: {
      prompt,
      messages,
      llm_provider: normalizeProvider(obj.llm_provider),
      llm_model: asNonEmptyString(obj.llm_model),
      intent_hint: asNonEmptyString(obj.intent_hint),
      disallow_clarify: asBoolean(obj.disallow_clarify, false),
      required_structured_keys: asStringArray(obj.required_structured_keys),
      prompt_template_id: promptTemplateId,
      prompt_hash: promptHash,
      parent_trace_id: parentTraceId,
      parent_request_id: parentRequestId,
      anchor_product_id: asNonEmptyString(obj.anchor_product_id),
      anchor_product_url: asNonEmptyString(obj.anchor_product_url),
      debug: asBoolean(obj.debug, false),
    },
  };
}

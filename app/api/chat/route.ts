import { randomUUID } from "crypto";
import { createTextStreamResponse } from "ai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRequest = {
  query?: string;
  message?: string;
  messages?: unknown[];
  action_id?: string;
  action_label?: string;
  action_data?: Record<string, unknown>;
  clarification_id?: string;
  selected_option_index?: number;
  anchor_product_id?: string;
  anchor_product_url?: string;
  llm_provider?: "gemini" | "openai";
  llm_model?: string;
  stream?: boolean;
  debug?: boolean;
  language?: string;
  session?: Record<string, unknown>;
  session_state?: string;
  current_state?: string;
};

type BffMessage = { role: string; content: string };

type BffAction = {
  action_id: string;
  kind?: "chip" | "action";
  data?: Record<string, unknown>;
};

type BffChatRequest = {
  message?: string;
  messages?: BffMessage[];
  action?: string | BffAction;
  session?: Record<string, unknown>;
  anchor_product_id?: string;
  anchor_product_url?: string;
  llm_provider?: "gemini" | "openai";
  llm_model?: string;
  language?: "CN" | "EN";
  debug?: boolean;
};

type BffSuggestedChip = {
  chip_id?: string;
  label?: string;
  kind?: "quick_reply" | "action";
  data?: Record<string, unknown>;
};

type BffCard = {
  card_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
  field_missing?: Array<{ field?: string; reason?: string }>;
};

type BffEnvelope = {
  request_id?: string;
  trace_id?: string;
  assistant_message?: { role?: string; content?: string; format?: string } | null;
  suggested_chips?: BffSuggestedChip[];
  cards?: BffCard[];
  session_patch?: Record<string, unknown>;
  events?: Record<string, unknown>[];
};

type NextActionChip = {
  id: string;
  label: string;
  text: string;
  next_state?: string;
};

type BffContextPrefix = {
  stripped_query: string;
};

const USER_ID_COOKIE_NAME = "aurora_uid";
const USER_ID_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const AURORA_CHAT_SCHEMA_VERSION = "aurora.chat.v1" as const;

function getPivotaAgentBaseUrl() {
  const raw =
    process.env.PIVOTA_AGENT_URL?.trim() ||
    process.env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() ||
    "https://pivota-agent-production.up.railway.app";
  return raw.replace(/\/$/, "");
}

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCookieHeader(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { path?: string; maxAgeSeconds?: number; sameSite?: "Lax" | "Strict" | "None"; secure?: boolean } = {},
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (typeof opts.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(opts.maxAgeSeconds))}`);
  }
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function getOrCreateAnonymousUserId(req: Request): { userId: string; setCookieHeader?: string } {
  const fromHeader = req.headers.get("x-aurora-uid")?.trim();
  if (fromHeader) return { userId: fromHeader.slice(0, 128) };

  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const existing = typeof cookies[USER_ID_COOKIE_NAME] === "string" ? cookies[USER_ID_COOKIE_NAME].trim() : "";
  if (existing) return { userId: existing.slice(0, 128) };

  const userId = randomUUID();
  const setCookieHeader = serializeCookie(USER_ID_COOKIE_NAME, userId, {
    path: "/",
    maxAgeSeconds: USER_ID_COOKIE_MAX_AGE_SECONDS,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  });
  return { userId, setCookieHeader };
}

function withSetCookie(response: Response, setCookieHeader?: string) {
  if (!setCookieHeader) return response;
  response.headers.append("Set-Cookie", setCookieHeader);
  return response;
}

function extractTextFromUnknownMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  if ("content" in message) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (hasRecord(content) && typeof content.text === "string") return content.text;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!hasRecord(part)) return "";
          if (part.type === "text" && typeof part.text === "string") return part.text;
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }

  if ("text" in message && typeof (message as Record<string, unknown>).text === "string") {
    return String((message as Record<string, unknown>).text);
  }

  if ("parts" in message && Array.isArray((message as Record<string, unknown>).parts)) {
    const text = ((message as Record<string, unknown>).parts as unknown[])
      .map((part) => {
        if (!hasRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }

  return "";
}

function normalizeQuery(body: ChatRequest): string {
  const query = typeof body.query === "string" && body.query.trim() ? body.query.trim() : "";
  if (query) return query;

  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "";
  if (message) return message;

  const actionLabel = typeof body.action_label === "string" && body.action_label.trim() ? body.action_label.trim() : "";
  if (actionLabel) return actionLabel;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastUser = [...body.messages]
      .reverse()
      .find((m) => hasRecord(m) && String(m.role || "").toLowerCase() === "user");
    const text = extractTextFromUnknownMessage(lastUser);
    if (text.trim()) return text.trim();
  }

  return "";
}

function normalizeUpstreamMessages(messages: unknown[]): BffMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: BffMessage[] = [];
  for (const msg of messages.slice(-50)) {
    if (!hasRecord(msg)) continue;
    const role = String(msg.role || "").trim();
    const content = extractTextFromUnknownMessage(msg).trim();
    if (!role || !content) continue;
    out.push({ role, content });
  }
  return out;
}

function detectUserLanguage(text: string): "CN" | "EN" {
  return /[\u4e00-\u9fff]/.test(String(text || "")) ? "CN" : "EN";
}

function normalizeAuroraLanguage(input: unknown): "CN" | "EN" | null {
  const value = typeof input === "string" ? input.trim().toUpperCase() : "";
  if (!value) return null;
  if (value === "CN" || value === "ZH" || value === "ZH-CN" || value === "ZH_HANS") return "CN";
  if (value === "EN" || value === "EN-US") return "EN";
  return null;
}

function toAuroraLanguageTag(lang: "CN" | "EN"): "zh-CN" | "en-US" {
  return lang === "CN" ? "zh-CN" : "en-US";
}

function normalizeChatLlmProvider(input: unknown): "gemini" | "openai" | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value === "gemini" || value === "openai") return value;
  return null;
}

function normalizeChatLlmModel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;
  return value.slice(0, 120);
}

function parseBffContextPrefix(rawQuery: string): BffContextPrefix | null {
  const raw = String(rawQuery || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  let cursor = 0;
  let sawAny = false;

  for (; cursor < lines.length; cursor += 1) {
    const line = String(lines[cursor] || "").trim();
    if (!line) {
      cursor += 1;
      break;
    }
    const m = line.match(/^(profile|recent_logs|meta)\s*=\s*(.+)$/i);
    if (!m) break;
    sawAny = true;
  }

  if (!sawAny) return null;
  return { stripped_query: lines.slice(cursor).join("\n").trim() };
}

function buildBffAction(body: ChatRequest): BffAction | null {
  const actionId = typeof body.action_id === "string" ? body.action_id.trim() : "";
  if (!actionId) return null;

  const data: Record<string, unknown> = hasRecord(body.action_data) ? { ...body.action_data } : {};
  if (typeof body.action_label === "string" && body.action_label.trim()) data.action_label = body.action_label.trim();
  if (typeof body.clarification_id === "string" && body.clarification_id.trim()) data.clarification_id = body.clarification_id.trim();
  if (typeof body.selected_option_index === "number" && Number.isFinite(body.selected_option_index)) {
    data.selected_option_index = Math.trunc(body.selected_option_index);
  }

  return {
    action_id: actionId,
    kind: "chip",
    ...(Object.keys(data).length ? { data } : {}),
  };
}

function deriveAnswerFromEnvelope(envelope: BffEnvelope, language: "CN" | "EN"): string {
  const assistantText =
    envelope.assistant_message && typeof envelope.assistant_message.content === "string"
      ? envelope.assistant_message.content.trim()
      : "";
  if (assistantText) return assistantText;

  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  for (const card of cards) {
    const payload = hasRecord(card?.payload) ? card.payload : {};
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message) return message;
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    if (summary) return summary;
    const analysisSummary = typeof payload.analysis_summary === "string" ? payload.analysis_summary.trim() : "";
    if (analysisSummary) return analysisSummary;

    if (card?.type === "diagnosis_gate") {
      const missing = Array.isArray(payload.missing_fields) ? payload.missing_fields.map((v) => String(v || "")).filter(Boolean) : [];
      if (missing.length) {
        return language === "CN"
          ? `需要先补齐诊断信息：${missing.join("、")}`
          : `Please complete diagnosis fields first: ${missing.join(", ")}`;
      }
      return language === "CN" ? "需要先完成基础诊断信息。" : "Please complete baseline diagnosis details first.";
    }
  }

  return language === "CN" ? "已收到。请继续输入你的问题。" : "Received. Please continue with your question.";
}

function deriveIntentFromEnvelope(envelope: BffEnvelope): string {
  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  const types = new Set(cards.map((card) => String(card?.type || "").trim().toLowerCase()).filter(Boolean));

  if (types.has("diagnosis_gate")) return "diagnosis_gate";
  if (types.has("analysis_summary")) return "analysis";
  if (types.has("recommendations")) return "reco_products";
  if (types.has("product_analysis")) return "product";
  if (types.has("confidence_notice")) return "confidence_notice";
  if (types.has("ingredient_plan")) return "ingredient_plan";
  return "chat";
}

function deriveCurrentState(envelope: BffEnvelope): string | null {
  const patch = hasRecord(envelope.session_patch) ? envelope.session_patch : null;
  if (!patch) return null;

  if (typeof patch.next_state === "string" && patch.next_state.trim()) return patch.next_state.trim();
  const state = hasRecord(patch.state) ? patch.state : null;
  if (state && typeof state._internal_next_state === "string" && state._internal_next_state.trim()) {
    return state._internal_next_state.trim();
  }
  return null;
}

function mapSuggestedChipsToNextActions(envelope: BffEnvelope, nextState: string | null): NextActionChip[] {
  const chips = Array.isArray(envelope.suggested_chips) ? envelope.suggested_chips : [];
  return chips
    .map((chip, idx) => {
      const id = String(chip?.chip_id || "").trim() || `chip_${idx + 1}`;
      const label = String(chip?.label || "").trim() || id;
      const data = hasRecord(chip?.data) ? chip.data : {};
      const text =
        typeof data.reply_text === "string" && data.reply_text.trim()
          ? data.reply_text.trim()
          : typeof data.replyText === "string" && data.replyText.trim()
            ? data.replyText.trim()
            : label;
      return { id, label, text, ...(nextState ? { next_state: nextState } : {}) };
    })
    .slice(0, 10);
}

function buildClarificationFromCards(envelope: BffEnvelope): Record<string, unknown> | undefined {
  const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
  const diagnosisGate = cards.find((card) => String(card?.type || "") === "diagnosis_gate");
  if (diagnosisGate && hasRecord(diagnosisGate.payload)) {
    const missingFields = Array.isArray(diagnosisGate.payload.missing_fields)
      ? diagnosisGate.payload.missing_fields.map((field) => String(field || "")).filter(Boolean)
      : [];
    return {
      questions: [],
      ...(missingFields.length ? { missing_fields: missingFields } : {}),
      gate_mode: "diagnosis_first",
    };
  }

  const confidenceNotice = cards.find((card) => String(card?.type || "") === "confidence_notice");
  if (confidenceNotice && hasRecord(confidenceNotice.payload)) {
    return {
      gate_mode: "low_confidence",
      ...(typeof confidenceNotice.payload.message === "string" ? { message: confidenceNotice.payload.message } : {}),
      ...(Array.isArray(confidenceNotice.payload.details) ? { details: confidenceNotice.payload.details } : {}),
      ...(Array.isArray(confidenceNotice.payload.actions) ? { actions: confidenceNotice.payload.actions } : {}),
    };
  }

  return undefined;
}

function streamTextResponse(text: string, opts: { chunkChars?: number; delayMs?: number } = {}) {
  const chunkChars = typeof opts.chunkChars === "number" && opts.chunkChars > 0 ? opts.chunkChars : 48;
  const delayMs = typeof opts.delayMs === "number" && opts.delayMs > 0 ? opts.delayMs : 0;

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));

  const textStream = new ReadableStream<string>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    },
  });

  return createTextStreamResponse({ textStream });
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawQuery = normalizeQuery(body);
  const prefixContext = parseBffContextPrefix(rawQuery);
  const query = prefixContext?.stripped_query?.trim() ? prefixContext.stripped_query.trim() : rawQuery;

  const action = buildBffAction(body);
  const normalizedMessages = normalizeUpstreamMessages(Array.isArray(body.messages) ? body.messages : []);

  if (!query && !action && normalizedMessages.length === 0) {
    return NextResponse.json({ error: "`query` (or `message`) is required" }, { status: 400 });
  }

  const { userId, setCookieHeader } = getOrCreateAnonymousUserId(req);
  const jsonResponse = (data: unknown, init?: Parameters<typeof NextResponse.json>[1]) =>
    withSetCookie(NextResponse.json(data, init), setCookieHeader);
  const streamResponse = (text: string, opts?: Parameters<typeof streamTextResponse>[1]) =>
    withSetCookie(streamTextResponse(text, opts), setCookieHeader);

  const langFromBody = normalizeAuroraLanguage(body.language);
  const langFromHeader = normalizeAuroraLanguage(req.headers.get("x-lang") || req.headers.get("x-aurora-lang"));
  const language: "CN" | "EN" = langFromBody || langFromHeader || detectUserLanguage(query);
  const llmProvider =
    normalizeChatLlmProvider(body.llm_provider) ||
    normalizeChatLlmProvider(req.headers.get("x-llm-provider") || req.headers.get("x-aurora-llm-provider"));
  const llmModel =
    normalizeChatLlmModel(body.llm_model) ||
    normalizeChatLlmModel(req.headers.get("x-llm-model") || req.headers.get("x-aurora-llm-model"));

  const baseUrl = getPivotaAgentBaseUrl();
  const url = `${baseUrl}/v1/chat`;
  const traceId = req.headers.get("x-trace-id")?.trim() || randomUUID();
  const briefId = req.headers.get("x-brief-id")?.trim() || randomUUID();

  const sessionPayload = hasRecord(body.session)
    ? body.session
    : (() => {
        const state = typeof body.session_state === "string" && body.session_state.trim()
          ? body.session_state.trim()
          : typeof body.current_state === "string" && body.current_state.trim()
            ? body.current_state.trim()
            : "";
        if (!state) return undefined;
        return { state } as Record<string, unknown>;
      })();

  const bffPayload: BffChatRequest = {
    ...(query ? { message: query } : {}),
    ...(normalizedMessages.length ? { messages: normalizedMessages } : {}),
    ...(action ? { action } : {}),
    ...(sessionPayload ? { session: sessionPayload } : {}),
    ...(typeof body.anchor_product_id === "string" && body.anchor_product_id.trim()
      ? { anchor_product_id: body.anchor_product_id.trim() }
      : {}),
    ...(typeof body.anchor_product_url === "string" && body.anchor_product_url.trim()
      ? { anchor_product_url: body.anchor_product_url.trim() }
      : {}),
    ...(llmProvider ? { llm_provider: llmProvider } : {}),
    ...(llmModel ? { llm_model: llmModel } : {}),
    language,
    ...(body.debug === true ? { debug: true } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let upstreamStatus = 500;
  let envelope: BffEnvelope | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Aurora-UID": userId,
        "X-Trace-ID": traceId,
        "X-Brief-ID": briefId,
        "X-Lang": language,
        "X-Aurora-Lang": language === "CN" ? "cn" : "en",
        ...(llmProvider ? { "X-LLM-Provider": llmProvider } : {}),
        ...(llmModel ? { "X-LLM-Model": llmModel } : {}),
      },
      body: JSON.stringify(bffPayload),
      signal: controller.signal,
    });

    upstreamStatus = res.status;
    const text = await res.text();
    const parsed = (() => {
      try {
        return JSON.parse(text) as BffEnvelope;
      } catch {
        return null;
      }
    })();

    if (!res.ok) {
      const errorMessage =
        parsed && hasRecord(parsed) && hasRecord((parsed as Record<string, unknown>).cards)
          ? "BFF request failed"
          : text || `BFF request failed (${res.status})`;
      return jsonResponse(
        {
          error: errorMessage,
          upstream_status: res.status,
          upstream_body: parsed ?? text,
        },
        { status: res.status >= 400 ? res.status : 502 },
      );
    }

    if (!parsed || !hasRecord(parsed)) {
      return jsonResponse(
        {
          error: "Invalid BFF response",
          upstream_status: res.status,
          upstream_body: text,
        },
        { status: 502 },
      );
    }

    envelope = parsed;
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "BFF request timed out"
        : error instanceof Error
          ? error.message
          : "BFF request failed";
    return jsonResponse(
      {
        error: message,
        upstream_status: upstreamStatus,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const answer = deriveAnswerFromEnvelope(envelope, language);
  if (Boolean(body.stream)) {
    return streamResponse(answer || (language === "CN" ? "已收到。" : "Received."));
  }

  const currentState = deriveCurrentState(envelope);
  const nextActions = mapSuggestedChipsToNextActions(envelope, currentState);
  const clarification = buildClarificationFromCards(envelope);

  return jsonResponse({
    schema_version: AURORA_CHAT_SCHEMA_VERSION,
    language: toAuroraLanguageTag(language),
    query,
    answer,
    intent: deriveIntentFromEnvelope(envelope),
    current_state: currentState,
    next_actions: nextActions,
    ...(clarification ? { clarification } : {}),
    llm_provider: llmProvider || "gemini",
    llm_model: llmModel || null,
    bff_request_id: typeof envelope.request_id === "string" ? envelope.request_id : null,
    bff_trace_id: typeof envelope.trace_id === "string" ? envelope.trace_id : traceId,
    cards: Array.isArray(envelope.cards) ? envelope.cards : [],
    suggested_chips: Array.isArray(envelope.suggested_chips) ? envelope.suggested_chips : [],
    session_patch: hasRecord(envelope.session_patch) ? envelope.session_patch : {},
    events: Array.isArray(envelope.events) ? envelope.events : [],
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    mode: "bff_proxy",
    upstream: `${getPivotaAgentBaseUrl()}/v1/chat`,
    message:
      "POST JSON to this endpoint. Example: { query?: string, message?: string, messages?: [], action_id?: string, action_data?: {}, stream?: boolean, llm_provider?: 'gemini'|'openai' }",
  });
}

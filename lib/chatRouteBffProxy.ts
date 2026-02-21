import { randomUUID } from "crypto";

import {
  buildProxyFallbackResponse,
  mapBffEnvelopeToChatProxyResponse,
  mapClientReqToBffChatReq,
  normalizeProxyFailureMode,
  normalizeProxyLanguage,
  type ProxyChatResponse,
  type ProxyFailureMode,
  type ProxyLanguage,
} from "./chatProxyBff.ts";

const DEFAULT_PIVOTA_AGENT_BASE_URL = "https://pivota-agent-production.up.railway.app";

type ProxyActionObject = {
  action_id?: string;
  kind?: "chip" | "action";
  data?: Record<string, unknown>;
};

export type ChatRouteProxyRequestBody = {
  query?: string;
  message?: string;
  messages?: unknown[];
  action_id?: string;
  action_label?: string;
  action_data?: Record<string, unknown>;
  action?: string | ProxyActionObject;
  session?: Record<string, unknown>;
  language?: string;
  client_state?: string;
  anchor_product_id?: string;
  anchor_product_url?: string;
  debug?: boolean;
};

export type ChatRouteBffProxyConfig = {
  enabled: boolean;
  failureMode: ProxyFailureMode;
  timeoutMs: number;
  baseUrl: string;
};

export type ChatRouteBffProxyResult =
  | { handled: false }
  | { handled: true; kind: "response"; response: ProxyChatResponse }
  | { handled: true; kind: "strict_error"; status: number; error: string };

type HandleChatRouteBffProxyArgs = {
  req: Request;
  body: ChatRouteProxyRequestBody;
  userId: string;
  extractTextFromUnknownMessage: (message: unknown) => string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

function readHeaderValue(req: Request, name: string) {
  const value = req.headers.get(name);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isChatRouteBffProxyEnabled(env: NodeJS.ProcessEnv = process.env) {
  return String(env.AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";
}

function readChatRouteBffProxyConfig(env: NodeJS.ProcessEnv = process.env): ChatRouteBffProxyConfig {
  const enabled = isChatRouteBffProxyEnabled(env);
  const failureMode = normalizeProxyFailureMode(env.AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE);
  const timeoutNum = Number(env.AURORA_CHAT_ROUTE_BFF_PROXY_TIMEOUT_MS || 18000);
  const timeoutMs = Number.isFinite(timeoutNum) ? Math.max(2000, Math.min(60000, Math.trunc(timeoutNum))) : 18000;
  const baseRaw = env.PIVOTA_AGENT_URL?.trim() || env.NEXT_PUBLIC_PIVOTA_AGENT_URL?.trim() || DEFAULT_PIVOTA_AGENT_BASE_URL;
  const baseUrl = baseRaw.replace(/\/$/, "");
  return { enabled, failureMode, timeoutMs, baseUrl };
}

function deriveProxyMessageFromBody(
  body: ChatRouteProxyRequestBody,
  extractTextFromUnknownMessage: (message: unknown) => string,
): string | null {
  const fromMessage = typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;
  if (fromMessage) return fromMessage;

  const fromQuery = typeof body.query === "string" && body.query.trim() ? body.query.trim() : null;
  if (fromQuery) return fromQuery;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || typeof row !== "object" || (row as any).role !== "user") continue;
    const content = extractTextFromUnknownMessage(row).trim();
    if (content) return content;
  }
  return null;
}

function normalizeProxyMessages(
  messages: unknown[],
  extractTextFromUnknownMessage: (message: unknown) => string,
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const item of Array.isArray(messages) ? messages.slice(-50) : []) {
    if (!item || typeof item !== "object") continue;
    const roleRaw = typeof (item as any).role === "string" ? (item as any).role.trim().toLowerCase() : "";
    if (!roleRaw || (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "system")) continue;
    const content = extractTextFromUnknownMessage(item).trim();
    if (!content) continue;
    out.push({ role: roleRaw, content });
  }
  return out;
}

function inferProxyLanguage(req: Request, body: ChatRouteProxyRequestBody): ProxyLanguage {
  const fromBody = typeof body.language === "string" ? body.language : "";
  if (fromBody) return normalizeProxyLanguage(fromBody, "EN");

  const fromHeader = readHeaderValue(req, "x-lang") || readHeaderValue(req, "x-aurora-lang");
  if (fromHeader) return normalizeProxyLanguage(fromHeader, "EN");
  return "EN";
}

function extractActionData(body: ChatRouteProxyRequestBody) {
  if (body.action_data && typeof body.action_data === "object" && !Array.isArray(body.action_data)) {
    return body.action_data;
  }
  if (body.action && typeof body.action === "object" && !Array.isArray(body.action)) {
    const data = (body.action as Record<string, unknown>).data;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  }
  return null;
}

function logProxyMetric(
  name: string,
  value: number,
  extra: Record<string, unknown> = {},
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) {
  const forceMetrics = String(runtimeEnv.AURORA_CHAT_ROUTE_BFF_PROXY_METRICS_FORCE || "")
    .trim()
    .toLowerCase();
  const shouldForce = forceMetrics === "1" || forceMetrics === "true" || forceMetrics === "yes" || forceMetrics === "on";
  if (shouldForce) {
    try {
      console.info("[aurora.chat.proxy.metric]", JSON.stringify({ kind: "metric", name, value, ...extra }));
    } catch {
      // no-op
    }
    return;
  }
  if (runtimeEnv.NODE_ENV === "test") return;
  if (process.argv.includes("--test") || process.execArgv.includes("--test")) return;
  try {
    console.info("[aurora.chat.proxy.metric]", JSON.stringify({ kind: "metric", name, value, ...extra }));
  } catch {
    // no-op
  }
}

async function callBffChatProxy({
  req,
  body,
  userId,
  config,
  extractTextFromUnknownMessage,
  fetchImpl,
}: {
  req: Request;
  body: ChatRouteProxyRequestBody;
  userId: string;
  config: ChatRouteBffProxyConfig;
  extractTextFromUnknownMessage: (message: unknown) => string;
  fetchImpl: typeof fetch;
}) {
  const traceId =
    readHeaderValue(req, "x-trace-id") ||
    (body.session && typeof body.session.trace_id === "string" ? body.session.trace_id.trim() : "") ||
    `trace_${randomUUID()}`;
  const briefId =
    readHeaderValue(req, "x-brief-id") ||
    (body.session && typeof body.session.brief_id === "string" ? body.session.brief_id.trim() : "") ||
    `brief_${randomUUID()}`;
  const auroraUid = readHeaderValue(req, "x-aurora-uid") || userId;
  const language = inferProxyLanguage(req, body);

  const actionId =
    (typeof body.action_id === "string" && body.action_id.trim() && body.action_id.trim()) ||
    (body.action && typeof body.action === "object" && typeof (body.action as any).action_id === "string"
      ? String((body.action as any).action_id).trim()
      : null);
  const actionLabel = typeof body.action_label === "string" && body.action_label.trim() ? body.action_label.trim() : null;

  const payload = mapClientReqToBffChatReq({
    message: deriveProxyMessageFromBody(body, extractTextFromUnknownMessage),
    messages: normalizeProxyMessages(Array.isArray(body.messages) ? body.messages : [], extractTextFromUnknownMessage),
    actionId,
    actionLabel,
    actionData: extractActionData(body),
    session: body.session && typeof body.session === "object" ? body.session : null,
    language,
    anchorProductId: body.anchor_product_id || null,
    anchorProductUrl: body.anchor_product_url || null,
    clientState: body.client_state || null,
    debug: body.debug === true,
  });

  const attempts = config.failureMode === "retry" ? 2 : 1;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}/v1/chat`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Aurora-UID": auroraUid,
          "X-Trace-ID": traceId,
          "X-Brief-ID": briefId,
          "X-Lang": language,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !json || typeof json !== "object") {
        const detail =
          json && typeof json.error === "string" && json.error.trim()
            ? json.error.trim()
            : `BFF /v1/chat failed (${response.status})`;
        throw new Error(detail);
      }
      return {
        traceId,
        language,
        response: mapBffEnvelopeToChatProxyResponse(json, traceId),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= attempts) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("BFF proxy call failed");
}

export async function handleChatRouteBffProxy({
  req,
  body,
  userId,
  extractTextFromUnknownMessage,
  env = process.env,
  fetchImpl = fetch,
}: HandleChatRouteBffProxyArgs): Promise<ChatRouteBffProxyResult> {
  const config = readChatRouteBffProxyConfig(env);
  if (!config.enabled) return { handled: false };

  try {
    const proxied = await callBffChatProxy({
      req,
      body,
      userId,
      config,
      extractTextFromUnknownMessage,
      fetchImpl,
    });

    logProxyMetric(
      "aurora.chat.proxy.success_rate",
      1,
      {
        mode: config.failureMode,
      },
      env,
    );
    return { handled: true, kind: "response", response: proxied.response };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logProxyMetric(
      "aurora.chat.proxy.success_rate",
      0,
      {
        mode: config.failureMode,
      },
      env,
    );

    if (config.failureMode === "strict") {
      return {
        handled: true,
        kind: "strict_error",
        status: 502,
        error: `BFF proxy failed: ${reason}`,
      };
    }

    const language = inferProxyLanguage(req, body);
    const requestId = `chatproxy_${Date.now()}`;
    const traceId = readHeaderValue(req, "x-trace-id") || `trace_${randomUUID()}`;
    const fallback = buildProxyFallbackResponse({
      language,
      requestId,
      traceId,
      reasonCode: "BFF_PROXY_FALLBACK",
      reason,
    });

    logProxyMetric(
      "aurora.chat.proxy.fallback_rate",
      1,
      {
        mode: config.failureMode,
      },
      env,
    );

    return {
      handled: true,
      kind: "response",
      response: fallback,
    };
  }
}

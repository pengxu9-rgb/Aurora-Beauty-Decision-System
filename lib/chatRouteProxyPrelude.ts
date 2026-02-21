import { randomUUID } from "crypto";

import { buildProxyFallbackResponse, normalizeProxyLanguage } from "./chatProxyBff.ts";
import {
  handleChatRouteBffProxy,
  isChatRouteBffProxyEnabled,
  type ChatRouteBffProxyResult,
  type ChatRouteProxyRequestBody,
} from "./chatRouteBffProxy.ts";

type ProxyPreludeResult =
  | ChatRouteBffProxyResult
  | {
      handled: false;
      reason: "proxy_disabled";
    };

type ResolveChatRouteProxyPreludeArgs = {
  req: Request;
  body: ChatRouteProxyRequestBody;
  userId: string;
  extractTextFromUnknownMessage: (message: unknown) => string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  idFactory?: () => string;
  proxyHandler?: (args: {
    req: Request;
    body: ChatRouteProxyRequestBody;
    userId: string;
    extractTextFromUnknownMessage: (message: unknown) => string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  }) => Promise<ChatRouteBffProxyResult>;
  proxyEnabledChecker?: (env?: NodeJS.ProcessEnv) => boolean;
};

function isRuntimeTest(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV === "test";
}

function isStrictProxyDecisionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return String(env.AURORA_CHAT_ROUTE_STRICT_PROXY_DECISION || "true")
    .trim()
    .toLowerCase() !== "false";
}

function safeWarn(message: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  if (isRuntimeTest(env)) return;
  try {
    console.warn(message, JSON.stringify(payload));
  } catch {
    // no-op
  }
}

function safeInfo(message: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  if (isRuntimeTest(env)) return;
  try {
    console.info(message, JSON.stringify(payload));
  } catch {
    // no-op
  }
}

export async function resolveChatRouteProxyPrelude({
  req,
  body,
  userId,
  extractTextFromUnknownMessage,
  env = process.env,
  fetchImpl,
  now = Date.now,
  idFactory = randomUUID,
  proxyHandler = handleChatRouteBffProxy,
  proxyEnabledChecker = isChatRouteBffProxyEnabled,
}: ResolveChatRouteProxyPreludeArgs): Promise<ProxyPreludeResult> {
  const proxyHandled = await proxyHandler({
    req,
    body,
    userId,
    extractTextFromUnknownMessage,
    env,
    fetchImpl,
  });
  if (proxyHandled.handled) return proxyHandled;

  const proxyEnabled = proxyEnabledChecker(env);
  if (proxyEnabled && isStrictProxyDecisionEnabled(env)) {
    const traceId = req.headers.get("x-trace-id")?.trim() || `trace_${idFactory()}`;
    const fallback = buildProxyFallbackResponse({
      language: normalizeProxyLanguage(body.language || req.headers.get("x-lang") || req.headers.get("x-aurora-lang") || "EN"),
      requestId: `chatproxy_${now()}`,
      traceId,
      reasonCode: "BFF_PROXY_UNEXPECTED_UNHANDLED",
      reason: "Proxy is enabled but returned unhandled; legacy path is blocked by policy.",
    });
    safeWarn(
      "[aurora.chat.proxy.unexpected_unhandled]",
      {
        reason_code: "BFF_PROXY_UNEXPECTED_UNHANDLED",
        trace_id: traceId,
      },
      env,
    );
    return {
      handled: true,
      kind: "response",
      response: fallback,
    };
  }

  if (proxyEnabled && !isStrictProxyDecisionEnabled(env)) {
    safeInfo(
      "[aurora.chat.proxy.metric]",
      {
        kind: "metric",
        name: "aurora.chat.proxy.legacy_path_used",
        value: 1,
        reason: "strict_proxy_decision_disabled",
      },
      env,
    );
    return { handled: false, reason: "proxy_disabled" };
  }

  safeInfo(
    "[aurora.chat.proxy.metric]",
    {
      kind: "metric",
      name: "aurora.chat.proxy.legacy_path_used",
      value: 1,
      reason: "proxy_disabled",
    },
    env,
  );
  return { handled: false, reason: "proxy_disabled" };
}

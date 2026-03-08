import { NextResponse } from "next/server.js";

import { buildProxyFallbackResponse, normalizeProxyLanguage } from "./chatProxyBff.ts";
import { resolveChatRouteProxyPrelude } from "./chatRouteProxyPrelude.ts";

type PublicChatBody = Record<string, unknown>;

function extractTextFromUnknownMessage(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

function readUserId(req: Request) {
  const fromHeader = req.headers.get("x-aurora-uid");
  if (fromHeader && fromHeader.trim()) return fromHeader.trim();
  return "public_anonymous";
}

function normalizeBody(body: unknown): PublicChatBody {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as PublicChatBody) : {};
}

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isMachineUpstreamRequest(req: Request, body: PublicChatBody) {
  if (hasNonEmptyString(body.prompt_template_id)) return true;
  if (Array.isArray(body.required_structured_keys) && body.required_structured_keys.some((item) => hasNonEmptyString(item))) {
    return true;
  }
  if (hasNonEmptyString(body.intent_hint)) return true;
  return (
    hasNonEmptyString(req.headers.get("x-prompt-template")) ||
    hasNonEmptyString(req.headers.get("x-prompt-hash")) ||
    hasNonEmptyString(req.headers.get("x-parent-trace-id")) ||
    hasNonEmptyString(req.headers.get("x-parent-request-id"))
  );
}

export async function handlePublicChatRequest(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const normalizedBody = normalizeBody(body);
  if (isMachineUpstreamRequest(req, normalizedBody)) {
    return NextResponse.json(
      {
        ok: false,
        error: "machine callers must use /api/upstream/chat",
        failure_reason: "wrong_endpoint",
      },
      { status: 400 },
    );
  }
  const proxyPrelude = await resolveChatRouteProxyPrelude({
    req,
    body: normalizedBody,
    userId: readUserId(req),
    extractTextFromUnknownMessage,
    env: process.env,
  });

  if (proxyPrelude.handled) {
    if (proxyPrelude.kind === "strict_error") {
      return NextResponse.json(
        {
          error: proxyPrelude.error,
          policy_version: "chat_route_proxy_strict_error_v1",
          degraded: true,
        },
        { status: proxyPrelude.status },
      );
    }
    return NextResponse.json(proxyPrelude.response);
  }

  const response = buildProxyFallbackResponse({
    language: normalizeProxyLanguage(normalizedBody.language || req.headers.get("x-lang") || req.headers.get("x-aurora-lang") || "EN"),
    requestId: `chatproxy_${Date.now()}`,
    traceId: req.headers.get("x-trace-id")?.trim() || `trace_${Date.now()}`,
    reasonCode: "PUBLIC_PROXY_DISABLED",
    reason: "Public /api/chat no longer serves legacy local decision logic; use the BFF proxy path.",
  });
  return NextResponse.json(response);
}

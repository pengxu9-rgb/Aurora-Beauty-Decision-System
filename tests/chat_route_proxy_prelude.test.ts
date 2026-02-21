import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatRouteProxyPrelude } from "../lib/chatRouteProxyPrelude.ts";

function makeReq(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
  });
}

const extractText = (message: unknown) => {
  if (!message || typeof message !== "object") return "";
  const content = (message as any).content;
  return typeof content === "string" ? content : "";
};

test("proxy prelude: pass-through response when proxy handler handled response", async () => {
  const out = await resolveChatRouteProxyPrelude({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: { ...process.env, NODE_ENV: "test" },
    proxyHandler: async () => ({
      handled: true,
      kind: "response",
      response: {
        answer: "ok",
        cards: [],
        suggested_chips: [],
        session_patch: {},
        events: [],
      },
    }),
  });

  assert.equal(out.handled, true);
  if (!out.handled) return;
  assert.equal(out.kind, "response");
});

test("proxy prelude: pass-through strict_error when proxy handler returns strict_error", async () => {
  const out = await resolveChatRouteProxyPrelude({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: { ...process.env, NODE_ENV: "test" },
    proxyHandler: async () => ({
      handled: true,
      kind: "strict_error",
      status: 502,
      error: "BFF proxy failed",
    }),
  });

  assert.equal(out.handled, true);
  if (!out.handled) return;
  assert.equal(out.kind, "strict_error");
});

test("proxy prelude: enabled + unhandled returns conservative fallback response", async () => {
  const out = await resolveChatRouteProxyPrelude({
    req: makeReq({ "x-lang": "CN", "x-trace-id": "trace_unhandled" }),
    body: { message: "继续", language: "CN" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: { ...process.env, NODE_ENV: "test" },
    proxyHandler: async () => ({ handled: false }),
    proxyEnabledChecker: () => true,
    now: () => 1700000000000,
    idFactory: () => "uuid_test",
  });

  assert.equal(out.handled, true);
  if (!out.handled || out.kind !== "response") return;
  assert.equal(out.response.cards?.some((c) => c.type === "confidence_notice"), true);
  assert.equal(out.response.cards?.some((c) => c.type === "diagnosis_gate"), true);
  assert.equal(out.response.events?.some((e) => e.reason_code === "BFF_PROXY_UNEXPECTED_UNHANDLED"), true);
});

test("proxy prelude: disabled + unhandled returns handled=false with proxy_disabled reason", async () => {
  const out = await resolveChatRouteProxyPrelude({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: { ...process.env, NODE_ENV: "test" },
    proxyHandler: async () => ({ handled: false }),
    proxyEnabledChecker: () => false,
  });

  assert.equal(out.handled, false);
  if (out.handled) return;
  assert.equal(out.reason, "proxy_disabled");
});

test("proxy prelude: strict proxy decision disabled allows legacy path even when proxy is enabled", async () => {
  const out = await resolveChatRouteProxyPrelude({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_STRICT_PROXY_DECISION: "false",
    },
    proxyHandler: async () => ({ handled: false }),
    proxyEnabledChecker: () => true,
  });

  assert.equal(out.handled, false);
  if (out.handled) return;
  assert.equal(out.reason, "proxy_disabled");
});

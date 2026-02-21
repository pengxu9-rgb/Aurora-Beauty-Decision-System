import assert from "node:assert/strict";
import test from "node:test";

import { handleChatRouteBffProxy, isChatRouteBffProxyEnabled } from "../lib/chatRouteBffProxy.ts";

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

test("isChatRouteBffProxyEnabled defaults to true and can be explicitly disabled", () => {
  assert.equal(isChatRouteBffProxyEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isChatRouteBffProxyEnabled({ AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(isChatRouteBffProxyEnabled({ AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "false" } as NodeJS.ProcessEnv), false);
});

test("proxy disabled: keeps legacy path (handled=false)", async () => {
  let called = 0;
  const result = await handleChatRouteBffProxy({
    req: makeReq(),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: { ...process.env, NODE_ENV: "test", AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "false" },
    fetchImpl: (async (...args: any[]) => {
      called += 1;
      return fetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch,
  });

  assert.equal(result.handled, false);
  assert.equal(called, 0);
});

test("proxy enabled success: maps envelope and forwards BFF headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await handleChatRouteBffProxy({
    req: makeReq({
      "x-aurora-uid": "uid_header",
      "x-trace-id": "trace_header",
      "x-brief-id": "brief_header",
      "x-lang": "CN",
    }),
    body: {
      message: "请推荐",
      // Intentionally include photo-like fields to prove they are not mapped.
      // @ts-expect-error contract guard
      use_photo: true,
      // @ts-expect-error contract guard
      photos: [{ photo_id: "p1" }],
    } as any,
    userId: "uid_cookie",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "fallback",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          request_id: "req_bff",
          trace_id: "trace_bff",
          assistant_message: { content: "ok from bff" },
          cards: [{ card_id: "c1", type: "analysis_summary", payload: {} }],
          suggested_chips: [],
          session_patch: {},
          events: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, "response");
  if (result.kind !== "response") return;

  assert.equal(result.response.answer, "ok from bff");
  assert.equal(result.response.bff_request_id, "req_bff");
  assert.equal(calls.length, 1);

  const call = calls[0];
  assert.equal(call.url, "https://bff.test/v1/chat");
  assert.equal((call.init?.headers as Record<string, string>)["X-Aurora-UID"], "uid_header");
  assert.equal((call.init?.headers as Record<string, string>)["X-Trace-ID"], "trace_header");
  assert.equal((call.init?.headers as Record<string, string>)["X-Brief-ID"], "brief_header");
  assert.equal((call.init?.headers as Record<string, string>)["X-Lang"], "CN");

  const payload = JSON.parse(String(call.init?.body || "{}"));
  assert.equal(payload.message, "请推荐");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "use_photo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "photos"), false);
});

test("proxy fallback mode: returns conservative response on upstream error", async () => {
  const result = await handleChatRouteBffProxy({
    req: makeReq({ "x-lang": "EN", "x-trace-id": "trace_fallback_test" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "fallback",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async () => {
      throw new Error("upstream timeout");
    }) as typeof fetch,
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, "response");
  if (result.kind !== "response") return;

  assert.equal(Array.isArray(result.response.cards), true);
  assert.equal(result.response.cards?.some((card) => card.type === "confidence_notice"), true);
  assert.equal(result.response.cards?.some((card) => card.type === "diagnosis_gate"), true);
  assert.equal(result.response.cards?.some((card) => card.type === "recommendations"), false);
  assert.equal(result.response.events?.some((evt) => evt.proxy_fallback === true), true);
});

test("proxy strict mode: returns strict_error instead of fallback cards", async () => {
  const result = await handleChatRouteBffProxy({
    req: makeReq({ "x-lang": "CN" }),
    body: { message: "hello" },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "strict",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async () => {
      throw new Error("503 from upstream");
    }) as typeof fetch,
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, "strict_error");
  if (result.kind !== "strict_error") return;

  assert.equal(result.status, 502);
  assert.match(result.error, /BFF proxy failed/i);
});

test("proxy retry mode: retries once then succeeds", async () => {
  let attempts = 0;
  const result = await handleChatRouteBffProxy({
    req: makeReq({ "x-lang": "EN" }),
    body: {
      messages: [
        { role: "assistant", content: "hi" },
        { role: "user", content: "I need recos" },
      ],
      action_id: "chip.start.reco_products",
    },
    userId: "uid_local",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "retry",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: "temporary" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          request_id: "req_retry",
          trace_id: "trace_retry",
          assistant_message: { content: "retry success" },
          cards: [],
          suggested_chips: [],
          session_patch: {},
          events: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  assert.equal(attempts, 2);
  assert.equal(result.handled, true);
  assert.equal(result.kind, "response");
  if (result.kind !== "response") return;
  assert.equal(result.response.answer, "retry success");
});

test("proxy metrics: success path emits success_rate metric when forced", async (t) => {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  t.after(() => {
    console.info = originalInfo;
  });

  const result = await handleChatRouteBffProxy({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_metric_success",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_METRICS_FORCE: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "fallback",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          request_id: "req_metric",
          trace_id: "trace_metric",
          assistant_message: { content: "ok" },
          cards: [],
          suggested_chips: [],
          session_patch: {},
          events: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, "response");
  assert.equal(logs.some((line) => line.includes("aurora.chat.proxy.success_rate") && line.includes("\"value\":1")), true);
});

test("proxy metrics: fallback path emits success_rate=0 and fallback_rate=1 when forced", async (t) => {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  t.after(() => {
    console.info = originalInfo;
  });

  const result = await handleChatRouteBffProxy({
    req: makeReq({ "x-lang": "EN" }),
    body: { message: "hello" },
    userId: "uid_metric_fallback",
    extractTextFromUnknownMessage: extractText,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_METRICS_FORCE: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "fallback",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    fetchImpl: (async () => {
      throw new Error("upstream timeout");
    }) as typeof fetch,
  });

  assert.equal(result.handled, true);
  assert.equal(result.kind, "response");
  assert.equal(logs.some((line) => line.includes("aurora.chat.proxy.success_rate") && line.includes("\"value\":0")), true);
  assert.equal(logs.some((line) => line.includes("aurora.chat.proxy.fallback_rate") && line.includes("\"value\":1")), true);
});

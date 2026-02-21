import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProxyFallbackResponse,
  mapBffEnvelopeToChatProxyResponse,
  mapClientReqToBffChatReq,
  normalizeProxyFailureMode,
  normalizeProxyLanguage,
} from "../lib/chatProxyBff.ts";

test("normalizeProxyLanguage handles zh/cn aliases", () => {
  assert.equal(normalizeProxyLanguage("CN"), "CN");
  assert.equal(normalizeProxyLanguage("zh-cn"), "CN");
  assert.equal(normalizeProxyLanguage("en"), "EN");
  assert.equal(normalizeProxyLanguage(""), "EN");
});

test("normalizeProxyFailureMode handles fallback/strict/retry", () => {
  assert.equal(normalizeProxyFailureMode("fallback"), "fallback");
  assert.equal(normalizeProxyFailureMode("strict"), "strict");
  assert.equal(normalizeProxyFailureMode("retry"), "retry");
  assert.equal(normalizeProxyFailureMode("unknown"), "fallback");
});

test("mapClientReqToBffChatReq maps action and session without breaking chat contract", () => {
  const payload = mapClientReqToBffChatReq({
    message: "please recommend",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    actionId: "chip.start.reco_products",
    actionLabel: "Get product recommendations",
    actionData: { trigger_source: "action" },
    session: { state: "S2_DIAGNOSIS", trace_id: "trace_x" },
    language: "CN",
    anchorProductId: "prod_123",
    clientState: "S2_DIAGNOSIS",
    debug: true,
  });

  assert.equal(payload.language, "CN");
  assert.equal(payload.message, "please recommend");
  assert.equal(Array.isArray(payload.messages), true);
  assert.equal((payload.action as any).action_id, "chip.start.reco_products");
  assert.equal((payload.action as any).kind, "chip");
  assert.deepEqual((payload.action as any).data, { trigger_source: "action" });
  assert.deepEqual(payload.session, { state: "S2_DIAGNOSIS", trace_id: "trace_x" });
  assert.equal(payload.anchor_product_id, "prod_123");
  assert.equal(payload.client_state, "S2_DIAGNOSIS");
  assert.equal(payload.debug, true);
});

test("mapClientReqToBffChatReq never injects photo fields into /v1/chat payload", () => {
  const payload = mapClientReqToBffChatReq({
    message: "run recommendation gate",
    language: "EN",
    session: { state: "S2_DIAGNOSIS" },
    // @ts-expect-error: explicit contract guard test (these fields should be ignored).
    use_photo: true,
    // @ts-expect-error: explicit contract guard test (these fields should be ignored).
    photos: [{ photo_id: "p1" }],
  } as any);

  assert.equal(Object.prototype.hasOwnProperty.call(payload, "use_photo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "photos"), false);
});

test("mapBffEnvelopeToChatProxyResponse keeps assistant/cards/chips fields", () => {
  const out = mapBffEnvelopeToChatProxyResponse(
    {
      request_id: "req_1",
      trace_id: "trace_1",
      assistant_message: { content: "ok" },
      cards: [{ card_id: "c1", type: "analysis_summary", payload: {} }],
      suggested_chips: [{ chip_id: "chip_1", label: "Next" }],
      session_patch: { next_state: "S5_ANALYSIS_SUMMARY" },
      events: [{ type: "value_moment" }],
      meta: { policy_version: "aurora_chat_v2_p0", degraded: false },
    },
    "trace_fallback",
  );

  assert.equal(out.answer, "ok");
  assert.equal(out.bff_request_id, "req_1");
  assert.equal(out.bff_trace_id, "trace_1");
  assert.equal(Array.isArray(out.cards), true);
  assert.equal(out.cards?.length, 1);
  assert.equal(Array.isArray(out.suggested_chips), true);
  assert.equal(out.suggested_chips?.length, 1);
  assert.deepEqual(out.session_patch, { next_state: "S5_ANALYSIS_SUMMARY" });
  assert.equal(Array.isArray(out.events), true);
  assert.equal(out.policy_version, "aurora_chat_v2_p0");
  assert.equal(out.degraded, undefined);
});

test("buildProxyFallbackResponse includes confidence notice + diagnosis gate + proxy_fallback event", () => {
  const out = buildProxyFallbackResponse({
    language: "EN",
    requestId: "req_fallback",
    traceId: "trace_fallback",
    reasonCode: "BFF_PROXY_FALLBACK",
    reason: "timeout",
  });

  assert.equal(out.bff_request_id, "req_fallback");
  assert.equal(out.bff_trace_id, "trace_fallback");
  assert.equal(Array.isArray(out.cards), true);
  assert.equal(out.cards?.some((c) => c.type === "confidence_notice"), true);
  assert.equal(out.cards?.some((c) => c.type === "diagnosis_gate"), true);
  assert.equal(out.cards?.some((c) => c.type === "recommendations"), false);
  assert.equal(Array.isArray(out.events), true);
  assert.equal(out.events?.some((e) => e.proxy_fallback === true), true);
  assert.equal(out.policy_version, "chat_route_proxy_degraded_v1");
  assert.equal(out.degraded, true);
  assert.equal((out.session_patch as any)?.meta?.degraded, true);

  const gateCard = out.cards?.find((c) => c.type === "diagnosis_gate");
  const missing = Array.isArray((gateCard as any)?.payload?.missing_fields) ? ((gateCard as any).payload.missing_fields as string[]) : [];
  assert.deepEqual(missing, ["skinType", "sensitivity", "barrierStatus", "goals"]);
});

test("mapBffEnvelopeToChatProxyResponse fills request/trace fallback ids when missing", () => {
  const out = mapBffEnvelopeToChatProxyResponse(
    {
      assistant_message: { content: "hello" },
      cards: [],
      suggested_chips: [],
      session_patch: {},
      events: [],
    },
    "trace_from_proxy",
  );

  assert.equal(typeof out.bff_request_id, "string");
  assert.equal((out.bff_request_id || "").startsWith("chatproxy_"), true);
  assert.equal(out.bff_trace_id, "trace_from_proxy");
});

import assert from "node:assert/strict";
import test from "node:test";

import { handlePublicChatRequest } from "../lib/publicChatFacade.ts";
import { readChatRouteBffProxyConfig } from "../lib/chatRouteBffProxy.ts";
import { handleUpstreamChatRequest } from "../lib/upstream/handleUpstreamChat.ts";
import { getProviderReadiness } from "../lib/upstream/providers.ts";
import { getUpstreamRouteHealth } from "../lib/upstream/handleUpstreamChat.ts";

function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).finally === "function") {
      return (out as Promise<void>).finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("upstream chat rejects unknown prompt template ids", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return JSON",
      prompt_template_id: "unknown_template_v1",
    },
    executePrompt: async () => {
      throw new Error("should not execute");
    },
  });

  assert.equal(response.status, 400);
  const payload = await readJson(response);
  assert.equal(payload.failure_reason, "unsupported_prompt_template_id");
});

test("upstream chat retries routine_fit_summary_v1 once and succeeds", async () => {
  const prompts: string[] = [];
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return the routine fit JSON",
      prompt_template_id: "routine_fit_summary_v1",
      required_structured_keys: ["overall_fit", "fit_score", "summary", "highlights", "concerns", "dimension_scores", "next_questions"],
      disallow_clarify: true,
      prompt_hash: "hash_routine_fit",
      parent_trace_id: "trace_123",
      parent_request_id: "req_123",
    },
    executePrompt: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          provider: "gemini",
          model: "gemini-test",
          text: JSON.stringify({
            overall_fit: "partial_match",
            fit_score: 0.61,
            summary: "Mostly aligned.",
            highlights: ["Barrier support present."],
            concerns: ["Active overlap risk."],
            dimension_scores: {
              ingredient_match: { score: 0.7, note: "Good alignment." },
              routine_completeness: { score: 0.6, note: "Core steps covered." },
              conflict_risk: { score: 0.4, note: "Needs simplification." },
              sensitivity_safety: { score: 0.5, note: "Monitor irritation." },
            },
          }),
        };
      }
      return {
        provider: "gemini",
        model: "gemini-test",
        text: JSON.stringify({
          overall_fit: "partial_match",
          fit_score: 0.61,
          summary: "Mostly aligned.",
          highlights: ["Barrier support present."],
          concerns: ["Active overlap risk."],
          dimension_scores: {
            ingredient_match: { score: 0.7, note: "Good alignment." },
            routine_completeness: { score: 0.6, note: "Core steps covered." },
            conflict_risk: { score: 0.4, note: "Needs simplification." },
            sensitivity_safety: { score: 0.5, note: "Monitor irritation." },
          },
          next_questions: ["What should I simplify first?"],
        }),
      };
    },
  });

  const payload = await readJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.retry_count, 1);
  assert.equal((payload.structured as Record<string, unknown>).overall_fit, "partial_match");
  assert.deepEqual(JSON.parse(String(payload.answer)), payload.structured);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /missing keys/i);
});

test("upstream chat returns machine-readable failure for missing reco alternatives", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return alternatives JSON",
      prompt_template_id: "reco_alternatives_v1_0",
      required_structured_keys: ["alternatives"],
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({ notes: ["missing alternatives"] }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(payload.failure_reason, "missing_required_keys");
  assert.deepEqual(payload.missing_keys, ["alternatives"]);
});

test("upstream chat converts missing provider env into machine-readable failure", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return strict JSON",
      prompt_template_id: "routine_fit_summary_v1",
      llm_provider: "gemini",
    },
    executePrompt: async () => {
      throw new Error("Missing required env var (one of): GEMINI_API_KEY, GOOGLE_API_KEY");
    },
  });

  const payload = await readJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(payload.failure_reason, "provider_env_missing");
  assert.equal(payload.prompt_template_id, "routine_fit_summary_v1");
});

test("upstream chat converts provider http failures into machine-readable failure", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return strict JSON",
      prompt_template_id: "routine_fit_summary_v1",
      llm_provider: "gemini",
    },
    executePrompt: async () => {
      throw new Error("Gemini generateContent failed (503): upstream unavailable");
    },
  });

  const payload = await readJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(payload.failure_reason, "provider_http_error");
  assert.equal(payload.upstream_status, 503);
});

test("upstream chat accepts shape-tolerant reco_main_v1_0 payloads", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return reco main JSON",
      prompt_template_id: "reco_main_v1_0",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        recommendations: [{ name: "Barrier serum", why: ["supports skin barrier"], slot: "PM" }],
        metadata: { confidence: 0.72 },
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "reco_products");
  assert.equal(Array.isArray((payload.structured as Record<string, unknown>).recommendations), true);
});

test("upstream chat accepts dupe_suggest_parse via parse.anchor_product", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Parse anchor product",
      prompt_template_id: "dupe_suggest_parse",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        parse: {
          anchor_product: {
            product_id: "sku_123",
            brand: "Pivota",
            name: "Barrier Serum",
            display_name: "Pivota Barrier Serum",
          },
        },
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "product_parse");
});

test("upstream chat accepts dupe_compare_parse via product object", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Parse dupe candidate product",
      prompt_template_id: "dupe_compare_parse",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        product: {
          product_id: "sku_456",
          brand: "Aurora",
          name: "Glow Gel",
          display_name: "Aurora Glow Gel",
        },
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "product_parse");
});

test("upstream chat accepts dupe_compare_main payloads consumable by BFF", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return compare JSON",
      prompt_template_id: "dupe_compare_main",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        original: { id: "orig_1" },
        dupe: { id: "dupe_1" },
        tradeoffs: ["lighter texture", "less soothing"],
        evidence: { strength: "moderate" },
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "dupe_compare");
  assert.equal(Array.isArray((payload.structured as Record<string, unknown>).tradeoffs), true);
});

test("upstream chat accepts generic machine prompts without template ids", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return strict JSON with candidate_ingredients",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        candidate_ingredients: [{ ingredient: "niacinamide", reason: "barrier support" }],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal((payload.structured as Record<string, unknown>).candidate_ingredients instanceof Array, true);
});

test("public /api/chat facade falls back conservatively when proxy is disabled", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "false",
    },
    async () => {
      const response = await handlePublicChatRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-lang": "EN" },
          body: JSON.stringify({ message: "hello" }),
        }),
      );

      const payload = await readJson(response);
      assert.equal(response.status, 200);
      assert.equal(Array.isArray(payload.cards), true);
      assert.equal((payload.cards as Array<Record<string, unknown>>).some((card) => card.type === "confidence_notice"), true);
    },
  );
});

test("public /api/chat rejects machine upstream payloads", async () => {
  const response = await handlePublicChatRequest(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-prompt-template": "routine_fit_summary_v1" },
      body: JSON.stringify({
        query: "Return JSON",
        prompt_template_id: "routine_fit_summary_v1",
        required_structured_keys: ["overall_fit"],
      }),
    }),
  );

  const payload = await readJson(response);
  assert.equal(response.status, 400);
  assert.equal(payload.failure_reason, "wrong_endpoint");
});

test("public /api/chat facade proxies to BFF when proxy is enabled", async (t) => {
  await withEnv(
    {
      NODE_ENV: "test",
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      AURORA_CHAT_ROUTE_BFF_PROXY_FAILURE_MODE: "fallback",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    async () => {
      const originalFetch = global.fetch;
      global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(url), "https://bff.test/v1/chat");
        const body = JSON.parse(String(init?.body || "{}"));
        assert.equal(body.message, "hello");
        return new Response(
          JSON.stringify({
            request_id: "req_public_proxy",
            trace_id: "trace_public_proxy",
            assistant_message: { content: "ok from bff" },
            cards: [],
            suggested_chips: [],
            session_patch: {},
            events: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      t.after(() => {
        global.fetch = originalFetch;
      });

      const response = await handlePublicChatRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-lang": "EN" },
          body: JSON.stringify({ message: "hello" }),
        }),
      );

      const payload = await readJson(response);
      assert.equal(payload.answer, "ok from bff");
    },
  );
});

test("public chat route config exposes proxy readiness inputs", async () => {
  await withEnv(
    {
      AURORA_CHAT_ROUTE_BFF_PROXY_ENABLED: "true",
      PIVOTA_AGENT_URL: "https://bff.test",
    },
    async () => {
      const payload = readChatRouteBffProxyConfig(process.env);
      assert.equal(payload.enabled, true);
      assert.equal(payload.baseUrl, "https://bff.test");
    },
  );
});

test("upstream route health exposes provider readiness and supported templates", async () => {
  await withEnv(
    {
      GEMINI_API_KEY: "gemini_test_key",
      OPENAI_API_KEY: undefined,
    },
    async () => {
      const payload = {
        ...getProviderReadiness(),
        ...getUpstreamRouteHealth(),
      };
      assert.equal(payload.gemini_configured, true);
      assert.equal(payload.openai_configured, false);
      assert.equal(Array.isArray(payload.supported_templates), true);
      assert.equal((payload.supported_templates as unknown[]).includes("routine_fit_summary_v1"), true);
    },
  );
});

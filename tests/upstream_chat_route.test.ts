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

test("upstream chat rejects generic reco_main_v1_0 empty recommendations", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return reco main JSON",
      prompt_template_id: "reco_main_v1_0",
      debug: true,
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        recommendations: [],
        metadata: { task_mode: "goal_based_products" },
        warnings: ["recent_logs_missing"],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.failure_reason, "empty_recommendations_rejected");
  assert.deepEqual(payload.missing_keys, ["recommendations"]);
  assert.equal(payload.debug?.empty_recommendations_rejected, true);
  assert.equal(Array.isArray(payload.debug?.attempts), true);
});

test("upstream chat accepts explicit ingredient no-candidate reco_main_v1_0 empty mode", async () => {
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
        recommendations: [],
        task_mode: "ingredient_lookup_no_candidates",
        products_empty_reason: "ingredient_constraint_no_match",
        missing_info: ["ingredient_constraint_no_match"],
        warnings: ["No verified product candidates containing the queried ingredient."],
        constraint_match_summary: { matched: 0, total: 0, dropped: 0 },
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "reco_products");
  assert.deepEqual((payload.structured as Record<string, unknown>).recommendations, []);
});

test("upstream chat rejects reco_main_v1_0 items without grounded identity and reasons", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return reco main JSON",
      prompt_template_id: "reco_main_v1_0",
      debug: true,
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        recommendations: [{ slot: "PM" }],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.failure_reason, "missing_required_keys");
  assert.equal(payload.missing_keys.includes("recommendations[0].identity"), true);
  assert.equal(payload.missing_keys.includes("recommendations[0].reasons"), true);
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


// ── the two ids the PIVOTA-Agent gateway ACTUALLY SENDS (2026-08-19 skew: both used to 400) ────────────────

test("upstream chat accepts reco_main_v1_2 — the id the gateway's mainline sends", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return reco main JSON",
      prompt_template_id: "reco_main_v1_2",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      // A realistic v1_2 item: identity at TOP level (brand/name/display_name) plus sku, reasons[],
      // and the v1_2-only enrichment fields — exactly what prompts/reco_main_v1_2.user_schema.json asks for.
      text: JSON.stringify({
        recommendations: [
          {
            slot: "treatment",
            step: "treatment",
            score: 82,
            product_type: "treatment",
            brand: "Paula's Choice",
            name: "2% BHA Liquid Exfoliant",
            display_name: "2% BHA Liquid Exfoliant",
            use_case: "Unclogs pores without scrubbing",
            concern_match: ["clogged pores"],
            skin_fit: ["sensitive"],
            constraint_notes: ["start 2-3x/week"],
            query_terms: ["bha exfoliant"],
            reasons: ["leave-on BHA, fragrance-free"],
            sku: { brand: "Paula's Choice", name: "2% BHA Liquid Exfoliant", sku_id: "sku_1", product_id: "sig_abc", category: "Exfoliant" },
            missing_info: [],
            warnings: [],
          },
        ],
        evidence: {},
        confidence: 0.74,
        missing_info: [],
        warnings: [],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "reco_products");
  assert.equal(payload.prompt_template_id, "reco_main_v1_2");
  const recs = (payload.structured as Record<string, unknown>).recommendations as unknown[];
  assert.equal(Array.isArray(recs) && recs.length === 1, true);
});

test("upstream chat accepts reco_main_v1_3 — the id the agent door sends", async () => {
  // SECOND OCCURRENCE of the id skew this section exists for. v1_0 -> v1_2 cost both reco surfaces
  // their recommendations on 2026-08-19; v1_3 400'd the agent door's whole LLM leg on 2026-09-09
  // (PIVOTA-Agent#2162, rolled back by env in #2165). The output contract is v1_2's byte for byte —
  // v1_3's user_schema.json is a copy — so an ordinary grounded answer must validate identically.
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: { query: "Return reco main JSON", prompt_template_id: "reco_main_v1_3" },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        recommendations: [
          {
            slot: "treatment",
            step: "treatment",
            score: 82,
            product_type: "bronzer",
            brand: "Sigma Beauty",
            name: "Matte Bronzer",
            display_name: "Matte Bronzer",
            use_case: "Adds warmth for contouring",
            concern_match: ["contour"],
            skin_fit: ["all"],
            constraint_notes: [],
            query_terms: ["matte bronzer"],
            reasons: ["blendable, buildable warmth"],
            sku: { brand: "Sigma Beauty", name: "Matte Bronzer", sku_id: "sku_9", product_id: "sig_bronzer", category: "Bronzer" },
            missing_info: [],
            warnings: [],
          },
        ],
        evidence: {},
        confidence: 0.7,
        missing_info: [],
        warnings: [],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "reco_products");
  assert.equal(payload.prompt_template_id, "reco_main_v1_3");
  const recs = (payload.structured as Record<string, unknown>).recommendations as unknown[];
  assert.equal(Array.isArray(recs) && recs.length === 1, true);
});

test("reco_main_v1_3 accepts a REASONED empty — its prompt instructs one — but still rejects a bare empty", async () => {
  // THE REASON v1_3 CANNOT REUSE v1_2's VALIDATOR. v1_3's DOMAIN BOUNDARY tells the model: "For a tool,
  // brush or device request, return recommendations: [] and say in missing_info that this lane does not
  // cover tools", and the same for any category it does not cover. The gateway still labels those calls
  // goal_based_products, which matches none of RECO_MAIN_EMPTY_TASK_MODE_HINTS — so under v1_2's
  // validator the registry would reject precisely the answers v1_3 asks the model to give.
  //
  // The guard is relaxed, not removed: an empty list with NO stated reason is the model failing rather
  // than refusing, and stays rejected.
  const call = (text: string, id: string) =>
    handleUpstreamChatRequest({
      req: new Request("http://localhost/api/upstream/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      body: { query: "Return reco main JSON", prompt_template_id: id },
      executePrompt: async () => ({ provider: "gemini", model: "gemini-test", text }),
    });

  const refusal = JSON.stringify({
    recommendations: [],
    missing_info: ["This lane does not cover beauty tools."],
    metadata: { task_mode: "goal_based_products" },
  });
  const reasoned = await readJson(await call(refusal, "reco_main_v1_3"));
  assert.equal(reasoned.ok, true, "a refusal that states its reason is a valid v1_3 answer");

  const bare = await readJson(
    await call(JSON.stringify({ recommendations: [], metadata: { task_mode: "goal_based_products" } }), "reco_main_v1_3"),
  );
  assert.equal(bare.ok, false);
  assert.equal(bare.failure_reason, "empty_recommendations_rejected", "a bare empty is still the model failing");

  // AND v1_2 IS UNCHANGED. The allowance is per-template: the same refusal body that v1_3 accepts must
  // still be rejected under v1_2, whose prompt never instructs an empty answer.
  const underV12 = await readJson(await call(refusal, "reco_main_v1_2"));
  assert.equal(underV12.ok, false);
  assert.equal(underV12.failure_reason, "empty_recommendations_rejected");
});

test("reco_main_v1_2 keeps the shared guards: generic empty is rejected, explicit no-candidate mode is not", async () => {
  const call = (text: string) =>
    handleUpstreamChatRequest({
      req: new Request("http://localhost/api/upstream/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      body: { query: "Return reco main JSON", prompt_template_id: "reco_main_v1_2" },
      executePrompt: async () => ({ provider: "gemini", model: "gemini-test", text }),
    });

  const generic = await readJson(await call(JSON.stringify({ recommendations: [], metadata: { task_mode: "goal_based_products" } })));
  assert.equal(generic.ok, false);
  assert.equal(generic.failure_reason, "empty_recommendations_rejected");

  const explicit = await readJson(
    await call(
      JSON.stringify({
        recommendations: [],
        task_mode: "ingredient_lookup_no_candidates",
        products_empty_reason: "ingredient_constraint_no_match",
        missing_info: ["ingredient_constraint_no_match"],
        warnings: ["No verified product candidates containing the queried ingredient."],
        constraint_match_summary: { matched: 0, total: 0, dropped: 0 },
      }),
    ),
  );
  assert.equal(explicit.ok, true);

  const ungrounded = await readJson(await call(JSON.stringify({ recommendations: [{ slot: "PM" }] })));
  assert.equal(ungrounded.ok, false);
  assert.equal(ungrounded.failure_reason, "missing_required_keys");
});

test("upstream chat accepts reco_alternatives_hybrid_v1 — the hybrid alternatives lane's id", async () => {
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: {
      query: "Return alternatives JSON",
      prompt_template_id: "reco_alternatives_hybrid_v1",
    },
    executePrompt: async () => ({
      provider: "gemini",
      model: "gemini-test",
      text: JSON.stringify({
        alternatives: [
          {
            kind: "similar",
            candidate_origin: "catalog",
            grounding_status: "catalog_verified",
            product: { brand: "The Ordinary", name: "Niacinamide 10% + Zinc 1%" },
            why_candidate: ["same hero active at a lower price"],
            tradeoffs: ["thinner texture"],
          },
        ],
      }),
    }),
  });

  const payload = await readJson(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.intent, "alternatives");
  assert.equal(Array.isArray((payload.structured as Record<string, unknown>).alternatives), true);
});

test("an id NO template registers still answers 400 unsupported_prompt_template_id", async () => {
  // The id here must be one that is genuinely unregistered, and it goes stale every time the gateway
  // advances: this control used to name reco_main_v1_3, which is now registered above — so it started
  // asserting 400 against a template that answers 200. Pick a version far past anything shipped.
  const response = await handleUpstreamChatRequest({
    req: new Request("http://localhost/api/upstream/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    body: { query: "x", prompt_template_id: "reco_main_v9_9" },
    executePrompt: async () => ({ provider: "gemini", model: "gemini-test", text: "{}" }),
  });
  assert.equal(response.status, 400);
  const payload = await readJson(response);
  assert.equal(payload.failure_reason, "unsupported_prompt_template_id");
});

test("the health listing advertises every id the gateway sends", async () => {
  const health = getUpstreamRouteHealth();
  const supported = (health as Record<string, unknown>).supported_templates as string[];
  for (const id of ["reco_main_v1_2", "reco_main_v1_3", "reco_alternatives_hybrid_v1", "reco_main_v1_0", "reco_alternatives_v1_0"]) {
    assert.equal(supported.includes(id), true, `${id} must be listed`);
  }
});

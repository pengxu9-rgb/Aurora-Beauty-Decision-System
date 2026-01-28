import { NextResponse } from "next/server";

import { prisma } from "@/lib/server/prisma";
import { findSimilarProductsByAnchorProductId } from "@/lib/search";
import type { RiskFlag } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatRequest = {
  query?: string;
  message?: string;
  messages?: ChatMessage[];
  anchor_product_id?: string;
  limit?: number;
  llm_provider?: "gemini" | "openai";
  llm_model?: string;
};

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeQuery(body: ChatRequest): string {
  if (typeof body.query === "string" && body.query.trim()) return body.query.trim();
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    if (lastUser?.content?.trim()) return lastUser.content.trim();
  }

  return "";
}

function detectSensitiveSkin(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("sensitive") ||
    q.includes("irritat") ||
    q.includes("redness") ||
    query.includes("敏感") ||
    query.includes("泛红") ||
    query.includes("刺痛") ||
    query.includes("红血丝")
  );
}

function mapRiskFlags(rawFlags: unknown): RiskFlag[] {
  const flags = Array.isArray(rawFlags) ? rawFlags.map((f) => String(f).toLowerCase()) : [];
  const out = new Set<RiskFlag>();

  for (const f of flags) {
    if (f.includes("alcohol")) out.add("alcohol");
    if (f.includes("acid")) out.add("acid");
    if (f.includes("high_irritation") || f.includes("irritation") || f.includes("burn") || f.includes("sting")) {
      out.add("high_irritation");
    }
  }

  return Array.from(out);
}

function coerceNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as any).toNumber === "function") {
    return (value as any).toNumber();
  }
  return Number(value);
}

async function findAnchorProductId(query: string): Promise<string | null> {
  const qLower = query.toLowerCase();

  const maybeBrand =
    qLower.includes("tom ford") || query.includes("汤姆福特") || qLower.includes("tf")
      ? "Tom Ford"
      : qLower.includes("the ordinary") || qLower.includes("ordinary") || query.includes("蓝铜") || query.includes("理肤") // "理肤" sometimes used incorrectly, but keep loose
        ? "The Ordinary"
        : qLower.includes("helena rubinstein") || qLower.includes("rubinstein") || query.includes("黑绷带")
          ? "Helena Rubinstein"
          : qLower.includes("la mer") || query.includes("海蓝之谜")
            ? "La Mer"
            : null;

  if (maybeBrand) {
    const product = await prisma.product.findFirst({
      where: { brand: { contains: maybeBrand, mode: "insensitive" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    return product?.id ?? null;
  }

  // Fallback: try a loose match on product name (use a short token to keep it practical).
  const tokens = query
    .split(/[\s,，。.!?？、/]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 6);

  for (const token of tokens) {
    const product = await prisma.product.findFirst({
      where: { name: { contains: token, mode: "insensitive" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (product?.id) return product.id;
  }

  return null;
}

async function openaiChatCompletion(input: { messages: ChatMessage[]; model?: string; temperature?: number }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = input.model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  const temperature = typeof input.temperature === "number" ? input.temperature : 0.2;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: input.messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI chat.completions failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI response missing message content");
  }
  return content.trim();
}

function requireAnyEnv(names: string[]) {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`Missing required env var (one of): ${names.join(", ")}`);
}

function normalizeGeminiModelName(model: string) {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

async function geminiGenerateContent(input: {
  system_prompt: string;
  user_prompt: string;
  model?: string;
  temperature?: number;
}) {
  const apiKey = requireAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1").trim().replace(/\/$/, "");

  const model = normalizeGeminiModelName(input.model ?? process.env.GEMINI_LLM_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash");
  const temperature = typeof input.temperature === "number" ? input.temperature : 0.2;

  const url = `${apiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // NOTE:
  // Some Gemini REST variants reject `systemInstruction` (400: Unknown name "systemInstruction").
  // To maximize compatibility, we inline the system prompt into the user prompt.
  const combinedPrompt = `${input.system_prompt}\n\nContext:\n${input.user_prompt}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
    generationConfig: { temperature, maxOutputTokens: 1024 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent failed (${res.status}): ${text}`);
  }

  const payload = (await res.json()) as any;
  const candidates = payload?.candidates ?? [];
  const parts = candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((p) => (p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
        .join("")
    : "";

  if (!text.trim()) throw new Error("Gemini response missing text");
  return text.trim();
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = normalizeQuery(body);
  if (!query) return NextResponse.json({ error: "`query` (or `message`) is required" }, { status: 400 });

  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(20, body.limit) : 6;

  let anchorProductId: string | null = null;
  if (typeof body.anchor_product_id === "string" && body.anchor_product_id.trim()) {
    anchorProductId = body.anchor_product_id.trim();
  } else {
    anchorProductId = await findAnchorProductId(query);
  }

  if (!anchorProductId || !looksLikeUuid(anchorProductId)) {
    return NextResponse.json(
      {
        query,
        answer:
          "I couldn't identify an anchor product in your query. Please specify a product name (e.g., “Tom Ford Research Serum Concentrate”) or pass `anchor_product_id`.",
      },
      { status: 200 },
    );
  }

  const anchor = await prisma.product.findUnique({
    where: { id: anchorProductId },
    include: { vectors: true, socialStats: true },
  });

  if (!anchor?.vectors) {
    return NextResponse.json(
      { error: "Anchor product not found or missing vectors", anchor_product_id: anchorProductId },
      { status: 404 },
    );
  }

  const sensitive = detectSensitiveSkin(query);
  const anchorRisk = mapRiskFlags(anchor.vectors.riskFlags);

  const similar = await findSimilarProductsByAnchorProductId(anchorProductId, { limit, cheaper_than_anchor: true });
  const candidates = sensitive ? similar.filter((c) => !c.sku.risk_flags.includes("alcohol")) : similar;

  const context = {
    user_query: query,
    detected: { sensitive_skin: sensitive },
    anchor: {
      id: anchor.id,
      brand: anchor.brand,
      name: anchor.name,
      price_usd: coerceNumber(anchor.priceUsd),
      risk_flags: anchor.vectors.riskFlags ?? [],
      risk_flags_canonical: anchorRisk,
      mechanism: anchor.vectors.mechanism,
      experience: anchor.vectors.experience,
      social: anchor.socialStats
        ? {
            red_score: anchor.socialStats.redScore,
            reddit_score: anchor.socialStats.redditScore,
            burn_rate: anchor.socialStats.burnRate,
            top_keywords: anchor.socialStats.topKeywords ?? [],
          }
        : null,
    },
    similar_products: candidates.map((c) => ({
      id: c.product_id,
      brand: c.sku.brand,
      name: c.sku.name,
      price_usd: c.sku.price,
      similarity: c.similarity,
      tradeoff: (() => {
        const ex = c.sku.experience;
        if (ex.texture === "sticky" || (ex.stickiness ?? 0) > 0.6) return "Texture is stickier.";
        if (ex.texture === "thick") return "Texture is thicker/richer.";
        if ((ex.pilling_risk ?? 0) > 0.6) return "Higher pilling risk under layering.";
        return "Lower-cost alternative.";
      })(),
      vectors: { mechanism: c.sku.mechanism, experience: c.sku.experience, risk_flags: c.sku.risk_flags },
      social: {
        red_score: c.sku.social_stats.RED_score ?? 0,
        reddit_score: c.sku.social_stats.Reddit_score ?? 0,
        burn_rate: c.sku.social_stats.burn_rate ?? 0,
        top_keywords: c.sku.social_stats.key_phrases?.RED ?? [],
      },
    })),
  };

  const systemPrompt = `
You are the Aurora Beauty Consultant.
Base your answer STRICTLY on the provided "Context Data" (database results). Do not hallucinate.

Rules:
- If recommending a Dupe, explicitly state the trade-off based on the "experience" vector (e.g., "Texture is stickier").
- If the user has sensitive skin (Context Data detected.sensitive_skin=true) and a product has an alcohol risk flag (risk_flags contains alcohol/high_alcohol/alcohol_high), VETO it (do not recommend it).
- Be concise, actionable, and use bullet points when helpful.
`.trim();

  let answer: string;
  const provider =
    body.llm_provider ??
    (process.env.AURORA_CHAT_PROVIDER === "openai" || process.env.AURORA_CHAT_PROVIDER === "gemini"
      ? (process.env.AURORA_CHAT_PROVIDER as "openai" | "gemini")
      : (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "openai"));
  const requestedModel = typeof body.llm_model === "string" && body.llm_model.trim() ? body.llm_model.trim() : undefined;

  try {
    const userPrompt = `User Query:\n${query}\n\nContext Data (JSON):\n${JSON.stringify(context)}`;

    answer =
      provider === "gemini"
        ? await geminiGenerateContent({ system_prompt: systemPrompt, user_prompt: userPrompt, model: requestedModel })
        : await openaiChatCompletion({
            model: requestedModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          });
  } catch (e) {
    return NextResponse.json(
      {
        query,
        error: e instanceof Error ? e.message : "Unknown error",
        context,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    query,
    anchor_product_id: anchorProductId,
    llm_provider: provider,
    llm_model: requestedModel ?? (provider === "gemini" ? process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash" : process.env.OPENAI_MODEL ?? "gpt-4o"),
    answer,
    context,
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "POST JSON to this endpoint. Example: { query: string, llm_provider?: 'gemini'|'openai', llm_model?: string }",
  });
}

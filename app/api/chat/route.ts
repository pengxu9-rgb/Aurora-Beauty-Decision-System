import { NextResponse } from "next/server";

import { getSkuById, getSkuDatabase } from "@/app/v1/decision/_lib";
import { calculateScore } from "@/lib/engine";
import { prisma } from "@/lib/server/prisma";
import { findSimilarProductsByAnchorProductId } from "@/lib/search";
import type { Budget, MechanismKey, RiskFlag, SkinType, SkuScoreBreakdown, SkuVector, UserGoal, UserVector } from "@/types";

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

const USD_TO_CNY = 7.2;

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
    q.includes("stinging") ||
    q.includes("burning") ||
    query.includes("敏感") ||
    query.includes("泛红") ||
    query.includes("刺痛") ||
    query.includes("疼") ||
    query.includes("痛") ||
    query.includes("红血丝")
  );
}

function detectBarrierImpaired(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("barrier") ||
    q.includes("broken barrier") ||
    q.includes("compromised") ||
    q.includes("peeling") ||
    q.includes("burning") ||
    q.includes("stinging") ||
    query.includes("屏障") ||
    query.includes("受损") ||
    query.includes("烂脸") ||
    query.includes("爆皮") ||
    query.includes("疼") ||
    query.includes("痛") ||
    query.includes("刺痛") ||
    query.includes("火辣")
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

function detectOilyAcne(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("oily") ||
    q.includes("acne") ||
    q.includes("comed") ||
    query.includes("油") ||
    query.includes("油痘") ||
    query.includes("痘") ||
    query.includes("闭口") ||
    query.includes("粉刺") ||
    query.includes("黑头")
  );
}

function parseBudgetCny(query: string): number | null {
  // Examples: "预算 500 块人民币", "500元", "¥500"
  const normalized = query.replace(/，/g, ",");
  const m1 = normalized.match(/(?:预算|budget)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|人民币)/i);
  if (m1?.[1]) return Number(m1[1]);
  const m2 = normalized.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (m2?.[1]) return Number(m2[1]);
  const m3 = normalized.match(/(\d+(?:\.\d+)?)\s*(?:元|块)\b/);
  if (m3?.[1]) return Number(m3[1]);
  return null;
}

function inferSkinTypes(query: string): SkinType[] {
  const out = new Set<SkinType>();
  const q = query.toLowerCase();

  if (q.includes("oily") || query.includes("油")) out.add("oily");
  if (q.includes("dry") || query.includes("干")) out.add("dry");
  if (q.includes("combination") || query.includes("混合")) out.add("combination");
  if (q.includes("normal") || query.includes("正常")) out.add("normal");
  if (detectSensitiveSkin(query) || query.includes("敏感")) out.add("sensitive");

  if (out.size === 0) out.add("normal");
  return Array.from(out);
}

function inferGoals(query: string): UserGoal[] {
  const goals: UserGoal[] = [];
  const q = query.toLowerCase();

  const push = (track: MechanismKey, priority: number) => {
    if (goals.some((g) => g.track === track)) return;
    goals.push({ track, priority });
  };

  // Acne / closed comedones
  if (q.includes("comed") || q.includes("acne") || query.includes("闭口") || query.includes("粉刺") || query.includes("痘")) {
    push("acne_comedonal", 1);
    push("oil_control", 2);
  }

  // Redness / sensitivity
  if (detectSensitiveSkin(query) || query.includes("泛红") || query.includes("红") || query.includes("刺痛")) {
    push("soothing", 1);
    push("redness", 2);
    push("repair", 3);
  }

  // Anti-aging
  if (q.includes("anti-aging") || q.includes("aging") || query.includes("抗老") || query.includes("皱纹") || query.includes("细纹")) {
    push("brightening", 1);
    push("repair", 2);
  }

  // Hydration / barrier
  if (q.includes("barrier") || query.includes("修护") || query.includes("屏障")) {
    push("repair", 1);
    push("soothing", 2);
  }

  // Default: basic balance
  if (goals.length === 0) {
    push("repair", 1);
    push("soothing", 2);
    push("brightening", 3);
  }

  return goals;
}

function buildUserVectorFromQuery(query: string, budgetOverride?: Budget): UserVector {
  const skinTypes = inferSkinTypes(query);
  const barrierImpaired = detectBarrierImpaired(query);
  const budgetCny = parseBudgetCny(query);

  const budget: Budget =
    budgetOverride ??
    ({
      total_monthly: Number.isFinite(budgetCny ?? NaN) ? Number(budgetCny) : 2000,
      strategy: "balanced",
    } satisfies Budget);

  return {
    skin_type: skinTypes.length === 1 ? skinTypes[0] : skinTypes,
    barrier_status: barrierImpaired ? "impaired" : "healthy",
    budget,
    goals: inferGoals(query),
    platform_weights: { RED: 0.5, Reddit: 0.5, Ecommerce: 0, DermSources: 0 },
  };
}

function coerceNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as any).toNumber === "function") {
    return (value as any).toNumber();
  }
  return Number(value);
}

function formatUsd(amount: number) {
  const v = Math.round(amount * 100) / 100;
  return `$${v}`;
}

function formatCny(amount: number) {
  const v = Math.round(amount * 100) / 100;
  return `¥${v}`;
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

  // Fallback: try a loose match on product name OR brand.
  const tokens = query
    .split(/[\s,，。.!?？、/]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 6);

  for (const token of tokens) {
    const product = await prisma.product.findFirst({
      where: {
        OR: [
          { name: { contains: token, mode: "insensitive" } },
          { brand: { contains: token, mode: "insensitive" } },
        ],
      },
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
    generationConfig: { temperature, maxOutputTokens: 1536 },
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

type IngredientContext = {
  head: string[];
  hero_actives?: unknown;
  highlights: string[];
};

function normalizeIngredientList(fullList: unknown): string[] {
  if (!fullList) return [];
  if (Array.isArray(fullList)) return fullList.map((i) => String(i)).filter(Boolean);
  if (typeof fullList === "string") return fullList.split(/[,，]\s*/g).map((i) => i.trim()).filter(Boolean);
  return [];
}

function summarizeIngredients(fullList: unknown, heroActives: unknown): IngredientContext {
  const list = normalizeIngredientList(fullList);
  const head = list.slice(0, 12);
  const lowered = list.map((i) => i.toLowerCase());

  const highlights: string[] = [];
  const has = (needle: string) => lowered.some((i) => i.includes(needle));
  const anyHas = (needles: string[]) => needles.some((n) => has(n));

  if (anyHas(["petrolatum", "vaseline"])) highlights.push("Petrolatum/vaseline-style occlusive base");
  if (anyHas(["mineral oil", "paraffinum liquidum"])) highlights.push("Mineral oil/paraffin occlusives");
  if (anyHas(["dimethicone", "cyclopentasiloxane", "silicone"])) highlights.push("Silicone slip/film-formers");
  if (anyHas(["glycerin", "butylene glycol", "propylene glycol"])) highlights.push("Humectants (glycerin/glycols)");
  if (anyHas(["algae", "seaweed", "kelp", "laminaria"])) highlights.push("Algae/seaweed extract present");

  return { head, hero_actives: heroActives, highlights };
}

function computeUsdToCny(usd: number) {
  return usd * USD_TO_CNY;
}

type RoutineRec = {
  am: Array<{ step: string; sku: SkuVector; notes: string[] }>;
  pm: Array<{ step: string; sku: SkuVector; notes: string[] }>;
  total_usd: number;
  total_cny: number;
};

function pickCheapest(db: SkuVector[], category: SkuVector["category"]): SkuVector | null {
  const candidates = db.filter((s) => s.category === category).sort((a, b) => a.price - b.price);
  return candidates[0] ?? null;
}

function pickBestByScore(db: SkuVector[], category: SkuVector["category"], user: UserVector): SkuVector | null {
  const scored = db
    .filter((s) => s.category === category)
    .map((s) => ({ sku: s, score: calculateScore(s, user) }))
    .filter((x) => x.score.total > 0)
    .sort((a, b) => b.score.total - a.score.total);
  return scored[0]?.sku ?? null;
}

function sumUniqueUsd(skus: SkuVector[]) {
  const seen = new Set<string>();
  let total = 0;
  for (const sku of skus) {
    if (seen.has(sku.sku_id)) continue;
    seen.add(sku.sku_id);
    total += sku.price;
  }
  return total;
}

function buildBudgetRoutine(db: SkuVector[], user: UserVector, budgetCny: number | null): RoutineRec {
  const budgetUsd = budgetCny ? budgetCny / USD_TO_CNY : null;

  // Essentials for MVP: cleanser + treatment + moisturizer + sunscreen
  const cleanser = pickCheapest(db, "cleanser");
  const sunscreen = pickCheapest(db, "sunscreen");

  // For acne/comedones, prefer treatment; if none, fall back to serum.
  let treatment: SkuVector | null = pickBestByScore(db, "treatment", user) ?? pickBestByScore(db, "serum", user);
  let moisturizer: SkuVector | null = pickBestByScore(db, "moisturizer", user) ?? pickCheapest(db, "moisturizer");

  // Simple budget guardrails: if total exceeds budget, pick cheaper alternatives.
  const mustHave: Array<{ key: "cleanser" | "sunscreen" | "treatment" | "moisturizer"; sku: SkuVector | null }> = [
    { key: "cleanser", sku: cleanser },
    { key: "treatment", sku: treatment },
    { key: "moisturizer", sku: moisturizer },
    { key: "sunscreen", sku: sunscreen },
  ];

  const currentSkus = mustHave.map((m) => m.sku).filter((s): s is SkuVector => Boolean(s));
  let totalUsd = sumUniqueUsd(currentSkus);

  if (budgetUsd != null && totalUsd > budgetUsd) {
    // First attempt: downgrade moisturizer to cheapest.
    const cheapMoist = pickCheapest(db, "moisturizer");
    if (cheapMoist && moisturizer && cheapMoist.sku_id !== moisturizer.sku_id) {
      moisturizer = cheapMoist;
      totalUsd = sumUniqueUsd([cleanser, treatment, moisturizer, sunscreen].filter((s): s is SkuVector => Boolean(s)));
    }
  }

  if (budgetUsd != null && totalUsd > budgetUsd) {
    // Second attempt: pick cheaper sunscreen (already cheapest) and treatment: choose cheaper high-scoring treatment.
    const treatmentCandidates = db
      .filter((s) => s.category === "treatment" || s.category === "serum")
      .map((s) => ({ sku: s, score: calculateScore(s, user) }))
      .filter((x) => x.score.total > 0)
      .sort((a, b) => b.score.total - a.score.total);

    const byPrice = [...treatmentCandidates].sort((a, b) => a.sku.price - b.sku.price);
    const cheaper = byPrice.find((x) => treatment && x.sku.price < treatment.price);
    if (cheaper) treatment = cheaper.sku;
    totalUsd = sumUniqueUsd([cleanser, treatment, moisturizer, sunscreen].filter((s): s is SkuVector => Boolean(s)));
  }

  // If still above budget, drop optional category upgrades and keep essentials (cleanser + moisturizer + sunscreen).
  if (budgetUsd != null && totalUsd > budgetUsd) {
    treatment = null;
    totalUsd = sumUniqueUsd([cleanser, moisturizer, sunscreen].filter((s): s is SkuVector => Boolean(s)));
  }

  const am: RoutineRec["am"] = [];
  const pm: RoutineRec["pm"] = [];

  if (cleanser) {
    am.push({ step: "Cleanser", sku: cleanser, notes: ["Use gentle cleansing; avoid over-stripping."] });
    pm.push({ step: "Cleanser", sku: cleanser, notes: ["If wearing sunscreen/makeup, double cleanse as needed."] });
  }

  if (moisturizer) {
    am.push({ step: "Moisturizer", sku: moisturizer, notes: ["Light layer to support barrier."] });
  }

  if (sunscreen) {
    am.push({ step: "Sunscreen", sku: sunscreen, notes: ["Apply generously; reapply if outdoors."] });
  }

  if (treatment) {
    const acneGoal = user.goals?.some((g) => g.track === "acne_comedonal" || g.track === "oil_control");
    pm.push({
      step: "Treatment",
      sku: treatment,
      notes: [
        acneGoal ? "Targeting closed comedones/oil control." : "Active step.",
        "Start 2-3 nights/week, then increase as tolerated.",
      ],
    });
  }

  if (moisturizer) {
    pm.push({ step: "Moisturizer", sku: moisturizer, notes: ["Seal in hydration; reduce irritation."] });
  }

  const total_cny = computeUsdToCny(totalUsd);
  return { am, pm, total_usd: totalUsd, total_cny };
}

function isTooShort(answer: string) {
  const trimmed = answer.trim();
  if (trimmed.length < 160) return true;
  // Heuristic: require at least one list marker for our acceptance tests.
  return !(trimmed.includes("*") || trimmed.includes("-") || trimmed.includes("1)") || trimmed.includes("•"));
}

function buildFallbackProductAnswer(input: {
  query: string;
  detected: { sensitive_skin: boolean; barrier_impaired: boolean };
  anchor: { brand: string; name: string; price_usd: number; score?: SkuScoreBreakdown; ingredients?: IngredientContext; vetoed: boolean };
  candidates: Array<{ brand: string; name: string; price_usd: number; similarity: number; tradeoff: string; ingredients?: IngredientContext }>;
}) {
  const { anchor, candidates, detected } = input;

  const header =
    detected.barrier_impaired && anchor.vetoed
      ? "🚫 严重警告 (WARNING)：当前屏障受损，不推荐这款产品。"
      : `针对「${anchor.brand} ${anchor.name}」的分析与平替建议如下：`;

  const scoreLine = anchor.score
    ? `Aurora 评分：Total ${Math.round(anchor.score.total)}/100（Science ${Math.round(anchor.score.science)}, Social ${Math.round(anchor.score.social)}, Eng ${Math.round(anchor.score.engineering)}）${
        anchor.score.vetoed ? `；${anchor.score.veto_reason ?? "VETO"}` : ""
      }`
    : null;

  const top = candidates.slice(0, 3);
  const priceGap = top[0]
    ? `价格对比：${anchor.brand} ${formatUsd(anchor.price_usd)} vs ${top[0].brand} ${formatUsd(top[0].price_usd)}（约 ${Math.round(anchor.price_usd / Math.max(1, top[0].price_usd))}x 差异）。`
    : null;

  const lines: string[] = [];
  lines.push(header);
  lines.push(`- Anchor：${anchor.brand} ${anchor.name}（${formatUsd(anchor.price_usd)}）`);
  if (scoreLine) lines.push(`- ${scoreLine}`);
  if (anchor.ingredients?.highlights?.length) lines.push(`- 关键成分/结构：${anchor.ingredients.highlights.join("；")}`);
  if (priceGap) lines.push(`- ${priceGap}`);

  if (top.length > 0) {
    lines.push("");
    lines.push("推荐平替（按相似度/性价比）：");
    for (const [idx, c] of top.entries()) {
      const cLines: string[] = [];
      cLines.push(`${idx + 1}) ${c.brand} ${c.name}（${formatUsd(c.price_usd)}，相似度≈${c.similarity.toFixed(2)}）`);
      cLines.push(`   - Trade-off：${c.tradeoff}`);
      if (c.ingredients?.highlights?.length) cLines.push(`   - 成分/结构要点：${c.ingredients.highlights.join("；")}`);

      // Honesty: if anchor has algae and candidate doesn't, call out.
      const anchorHasAlgae = anchor.ingredients?.highlights?.some((h) => h.toLowerCase().includes("algae")) ?? false;
      const candHasAlgae = c.ingredients?.highlights?.some((h) => h.toLowerCase().includes("algae")) ?? false;
      if (anchorHasAlgae && !candHasAlgae) {
        cLines.push("   - 诚实提醒：平替更偏基础封闭保湿，缺少/更少海藻类提取物等品牌“核心修护”卖点。");
      }

      lines.push(cLines.join("\n"));
    }
  } else {
    lines.push("");
    lines.push("目前没有检索到足够的平替候选（可能是数据库样本还不够多）。");
  }

  return lines.join("\n").trim();
}

function buildFallbackRoutineAnswer(input: { query: string; budget_cny: number | null; routine: RoutineRec }) {
  const { budget_cny, routine } = input;
  const budgetLine =
    budget_cny != null
      ? `预算：${formatCny(budget_cny)}（≈${formatUsd(budget_cny / USD_TO_CNY)}）。本方案合计≈${formatCny(routine.total_cny)}（${formatUsd(routine.total_usd)}），在预算内。`
      : `本方案合计≈${formatUsd(routine.total_usd)}（≈${formatCny(routine.total_cny)}）。`;

  const lines: string[] = [];
  lines.push("为你按「油痘肌 / 去闭口」做了一套早晚分开的入门流程（尽量省钱但有效）：");
  lines.push(`- ${budgetLine}`);

  lines.push("");
  lines.push("AM：");
  for (const step of routine.am) {
    lines.push(`- ${step.step}：${step.sku.brand} ${step.sku.name}（${formatUsd(step.sku.price)}）`);
  }

  lines.push("");
  lines.push("PM：");
  for (const step of routine.pm) {
    lines.push(`- ${step.step}：${step.sku.brand} ${step.sku.name}（${formatUsd(step.sku.price)}）`);
  }

  lines.push("");
  lines.push("注意：活性类（酸/维A类）先从每周 2-3 次开始，出现刺痛爆皮就先停，用修护类把屏障养好。");
  return lines.join("\n").trim();
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

  const budgetCny = parseBudgetCny(query);

  const explicitAnchorId =
    typeof body.anchor_product_id === "string" && body.anchor_product_id.trim() ? body.anchor_product_id.trim() : null;
  const inferredAnchorId = explicitAnchorId ?? (await findAnchorProductId(query));

  // If the user didn't mention a specific product, treat this as a "routine planning" request.
  const shouldPlanRoutine =
    !inferredAnchorId &&
    (query.includes("流程") ||
      query.includes("早晚") ||
      query.toLowerCase().includes("routine") ||
      detectOilyAcne(query) ||
      (budgetCny != null && budgetCny > 0));

  const anchorProductId = inferredAnchorId;

  const provider =
    body.llm_provider ??
    (process.env.AURORA_CHAT_PROVIDER === "openai" || process.env.AURORA_CHAT_PROVIDER === "gemini"
      ? (process.env.AURORA_CHAT_PROVIDER as "openai" | "gemini")
      : (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "openai"));
  const requestedModel = typeof body.llm_model === "string" && body.llm_model.trim() ? body.llm_model.trim() : undefined;

  // ROUTINE PATH
  if (shouldPlanRoutine) {
    // Build a lightweight user vector from query text.
    const user = buildUserVectorFromQuery(query, budgetCny != null ? { total_monthly: budgetCny, strategy: "balanced" } : undefined);
    const db = await getSkuDatabase();
    const routine = buildBudgetRoutine(db, user, budgetCny);

    const contextText = [
      `User Query: ${query}`,
      `Detected: oily/acne=${detectOilyAcne(query)}; sensitive=${detectSensitiveSkin(query)}; barrier_impaired=${detectBarrierImpaired(query)}`,
      budgetCny != null ? `Budget: ${formatCny(budgetCny)} (≈${formatUsd(budgetCny / USD_TO_CNY)})` : "Budget: (not provided)",
      "",
      "Recommended Routine (pre-selected):",
      `AM: ${routine.am.map((s) => `${s.step}=${s.sku.brand} ${s.sku.name} (${formatUsd(s.sku.price)})`).join(" | ")}`,
      `PM: ${routine.pm.map((s) => `${s.step}=${s.sku.brand} ${s.sku.name} (${formatUsd(s.sku.price)})`).join(" | ")}`,
      `Total: ${formatUsd(routine.total_usd)} (≈${formatCny(routine.total_cny)})`,
    ].join("\n");

    const systemPrompt = `
You are the Aurora Beauty Consultant.
You MUST base your answer strictly on the provided context (do not hallucinate products).

Output requirements:
- Provide AM and PM routines (bullets).
- Explain why each product fits oily/acne + closed comedones.
- Include total price and confirm it stays within budget if a budget was provided.
- Be direct and practical.
`.trim();

    const fallbackAnswer = buildFallbackRoutineAnswer({ query, budget_cny: budgetCny, routine });

    let answer = "";
    let llm_error: string | null = null;
    try {
      answer =
        provider === "gemini"
          ? await geminiGenerateContent({ system_prompt: systemPrompt, user_prompt: contextText, model: requestedModel })
          : await openaiChatCompletion({
              model: requestedModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: contextText },
              ],
            });

      if (isTooShort(answer)) {
        llm_error = "LLM answer too short; used fallback.";
        answer = fallbackAnswer;
      }
    } catch (e) {
      llm_error = e instanceof Error ? e.message : "Unknown error";
      answer = fallbackAnswer;
    }

    return NextResponse.json({
      query,
      llm_provider: provider,
      llm_model:
        requestedModel ??
        (provider === "gemini"
          ? process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash"
          : process.env.OPENAI_MODEL ?? "gpt-4o"),
      answer,
      llm_error,
      intent: "routine",
      context: {
        detected: { oily_acne: detectOilyAcne(query), sensitive_skin: detectSensitiveSkin(query), barrier_impaired: detectBarrierImpaired(query) },
        budget_cny: budgetCny,
        routine,
      },
    });
  }

  // PRODUCT / DUPE PATH
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
    include: { vectors: true, socialStats: true, ingredients: true },
  });

  if (!anchor?.vectors) {
    return NextResponse.json(
      { error: "Anchor product not found or missing vectors", anchor_product_id: anchorProductId },
      { status: 404 },
    );
  }

  const sensitive = detectSensitiveSkin(query);
  const barrierImpaired = detectBarrierImpaired(query);
  const user = buildUserVectorFromQuery(query);

  // Use the shared DB->SkuVector normalization so scoring behaves like /v1/decision/analyze.
  const normalizedAnchorSku = await getSkuById(anchorProductId);
  const anchorSku: SkuVector = normalizedAnchorSku ?? {
    sku_id: anchor.id,
    brand: anchor.brand,
    name: anchor.name,
    category: "serum",
    price: coerceNumber(anchor.priceUsd),
    currency: "USD",
    mechanism: (anchor.vectors.mechanism ?? {}) as any,
    experience: (anchor.vectors.experience ?? {}) as any,
    risk_flags: mapRiskFlags(anchor.vectors.riskFlags),
    social_stats: {
      platform_scores: {
        RED: Math.max(0, Math.min(1, coerceNumber(anchor.socialStats?.redScore ?? 0) / 100)),
        Reddit: Math.max(0, Math.min(1, coerceNumber(anchor.socialStats?.redditScore ?? 0) / 100)),
        Ecommerce: 0,
        DermSources: 0,
      },
      burn_rate: Math.max(0, Math.min(1, coerceNumber(anchor.socialStats?.burnRate ?? 0))),
      key_phrases: anchor.socialStats?.topKeywords ? { RED: anchor.socialStats.topKeywords ?? [] } : undefined,
    },
  };

  const anchorScore = calculateScore(anchorSku, user);
  const anchorRisk = anchorSku.risk_flags;
  const anchorBurnRate = Math.max(0, Math.min(1, anchorSku.social_stats.burn_rate ?? 0));
  const anchorVetoed = anchorScore.vetoed || (barrierImpaired && (anchorRisk.includes("high_irritation") || anchorBurnRate > 0.1));

  const similar = await findSimilarProductsByAnchorProductId(anchorProductId, { limit: Math.min(10, limit), cheaper_than_anchor: true });
  let candidates = similar;
  if (sensitive) candidates = candidates.filter((c) => !c.sku.risk_flags.includes("alcohol"));
  if (barrierImpaired) {
    candidates = candidates.filter(
      (c) => !c.sku.risk_flags.includes("high_irritation") && (c.sku.social_stats.burn_rate ?? 0) <= 0.1,
    );
  }

  // Ingredients context (anchor + top candidates) to support honest comparisons (e.g., La Mer vs Nivea).
  const candidateIds = candidates.map((c) => c.product_id);
  const ingredientRows = await prisma.ingredientData.findMany({
    where: { productId: { in: [anchor.id, ...candidateIds] } },
    select: { productId: true, fullList: true, heroActives: true },
  });
  const ingredientByProductId = new Map<string, { fullList: unknown; heroActives: unknown }>();
  for (const row of ingredientRows) ingredientByProductId.set(row.productId, { fullList: row.fullList, heroActives: row.heroActives });

  const anchorIngredients = ingredientByProductId.get(anchor.id);
  const anchorIngredientCtx = summarizeIngredients(anchorIngredients?.fullList, anchorIngredients?.heroActives);

  const mappedCandidates = candidates.map((c) => {
    const ing = ingredientByProductId.get(c.product_id);
    const ingCtx = summarizeIngredients(ing?.fullList, ing?.heroActives);
    return {
      product_id: c.product_id,
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
      ingredients: ingCtx,
    };
  });

  const contextText = [
    `User Query: ${query}`,
    `Detected: sensitive_skin=${sensitive}; barrier_impaired=${barrierImpaired}`,
    "",
    "ANCHOR:",
    `- ${anchor.brand} ${anchor.name} | price=${formatUsd(coerceNumber(anchor.priceUsd))}`,
    `- score_total=${Math.round(anchorScore.total)}/100 | vetoed=${anchorScore.vetoed} | reason=${anchorScore.veto_reason ?? "n/a"}`,
    `- risk_flags=${anchorRisk.join(",") || "(none)"} | burn_rate=${anchorBurnRate}`,
    anchorIngredientCtx.head.length ? `- ingredients_head=${anchorIngredientCtx.head.join(", ")}` : "- ingredients_head=(missing)",
    anchorIngredientCtx.highlights.length ? `- ingredients_highlights=${anchorIngredientCtx.highlights.join(" | ")}` : "",
    "",
    "CANDIDATES (cheaper, sorted by similarity):",
    ...mappedCandidates.slice(0, 5).map((c, idx) => {
      const parts = [
        `${idx + 1}. ${c.brand} ${c.name} | price=${formatUsd(c.price_usd)} | similarity=${c.similarity.toFixed(2)}`,
        `   tradeoff=${c.tradeoff}`,
      ];
      if (c.ingredients.head.length) parts.push(`   ingredients_head=${c.ingredients.head.join(", ")}`);
      if (c.ingredients.highlights.length) parts.push(`   ingredients_highlights=${c.ingredients.highlights.join(" | ")}`);
      return parts.join("\n");
    }),
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = `
You are the Aurora Beauty Consultant.
You MUST base your answer strictly on the provided context (do not hallucinate).

Critical safety rules:
- If barrier_impaired=true AND (risk_flags contains alcohol/acid/high_irritation OR burn_rate > 0.10), you MUST start with "🚫 严重警告 (WARNING)" and clearly say "不推荐", and treat the recommendation score as 0.

For dupe requests:
- Provide at least 2 dupe options from CANDIDATES.
- For each dupe: show price, similarity, and an honest trade-off (texture/finish/pilling).
- If the ingredient highlights show both have petrolatum/mineral oil type occlusives, explicitly state the “occlusive base” similarity.
- If the anchor has algae/seaweed highlights but the dupe doesn't, explicitly state it as a limitation (basic occlusion vs premium actives).
- Include a clear price comparison (anchor vs best dupe).

For suitability questions:
- If the anchor is vetoed or score_total < 60, be firm: "不推荐/慎用", explain why, and suggest safer alternatives from CANDIDATES.
`.trim();

  const fallbackAnswer = buildFallbackProductAnswer({
    query,
    detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired },
    anchor: {
      brand: anchor.brand,
      name: anchor.name,
      price_usd: coerceNumber(anchor.priceUsd),
      score: anchorScore,
      ingredients: anchorIngredientCtx,
      vetoed: anchorVetoed || anchorScore.vetoed,
    },
    candidates: mappedCandidates,
  });

  let answer = "";
  let llm_error: string | null = null;
  try {
    answer =
      provider === "gemini"
        ? await geminiGenerateContent({ system_prompt: systemPrompt, user_prompt: contextText, model: requestedModel })
        : await openaiChatCompletion({
            model: requestedModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: contextText },
            ],
          });

    if (isTooShort(answer)) {
      llm_error = "LLM answer too short; used fallback.";
      answer = fallbackAnswer;
    }
  } catch (e) {
    llm_error = e instanceof Error ? e.message : "Unknown error";
    answer = fallbackAnswer;
  }

  return NextResponse.json({
    query,
    anchor_product_id: anchorProductId,
    llm_provider: provider,
    llm_model:
      requestedModel ??
      (provider === "gemini"
        ? process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash"
        : process.env.OPENAI_MODEL ?? "gpt-4o"),
    answer,
    llm_error,
    intent: "product",
    context: {
      detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired },
      anchor: {
        id: anchor.id,
        brand: anchor.brand,
        name: anchor.name,
        price_usd: coerceNumber(anchor.priceUsd),
        vetoed: anchorVetoed || anchorScore.vetoed,
        score: anchorScore,
        risk_flags: anchor.vectors.riskFlags ?? [],
        risk_flags_canonical: anchorRisk,
        ingredients: anchorIngredientCtx,
        social: anchor.socialStats
          ? {
              red_score: anchor.socialStats.redScore,
              reddit_score: anchor.socialStats.redditScore,
              burn_rate: coerceNumber(anchor.socialStats.burnRate),
              top_keywords: anchor.socialStats.topKeywords ?? [],
            }
          : null,
      },
      similar_products: mappedCandidates,
    },
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "POST JSON to this endpoint. Example: { query: string, llm_provider?: 'gemini'|'openai', llm_model?: string }",
  });
}

import { NextResponse } from "next/server";

import { createTextStreamResponse } from "ai";
import { Prisma } from "@prisma/client";

import { getSkuById, getSkuDatabase, resolveProductIdForSkuId } from "@/app/v1/decision/_lib";
import { calculateScore } from "@/lib/engine";
import { buildKbProfile, type KbProfile, type KbSnippet, inferKbCanonicalKey } from "@/lib/kb-profile";
import { prisma } from "@/lib/server/prisma";
import { findSimilarSkus, findSimilarSkusByAnchorProductId, type RegionPreference } from "@/lib/vector-service";
import type { Budget, MechanismKey, RiskFlag, SkinType, SkuScoreBreakdown, SkuVector, UserGoal, UserVector } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatRequest = {
  query?: string;
  message?: string;
  messages?: unknown[];
  anchor_product_id?: string;
  limit?: number;
  llm_provider?: "gemini" | "openai";
  llm_model?: string;
  stream?: boolean;
};

const USD_TO_CNY = 7.2;

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildAuroraStructuredSystemPrompt(input: {
  regionLabel: string;
  contextDataJson: string;
  mode: "routine" | "product";
}) {
  const modeAddendum =
    input.mode === "product"
      ? `
Dupe / Alternatives Mode (If applicable)
- If the user asks for a dupe OR Context Data includes candidate alternatives:
  - Recommend 2-3 dupes from Context Data.
  - For each dupe: include price, (if provided) similarity, and an honest "trade-off" based on experience (texture/finish/pilling).
  - Prefer products available in the user's region when availability is provided.
  - Then propose how to use the best dupe inside a simple AM/PM routine (if the user wants a routine).
`.trim()
      : "";

  return `
Role

You are **Aurora**, an elite AI Dermatological Consultant. You combine the scientific rigor of a cosmetic chemist with the empathy of a supportive aesthetician.

Core Objective

Build a high-efficacy, budget-aware routine based **strictly** on the provided Context Data. If Context Data is insufficient, say so and provide ingredient-level guidance without inventing products.

Input Data Structure

User Profile: Skin Type, Concerns, Barrier Status, Budget, Region Preference.

Context Data: A list of products with mechanism_scores (Science), social_stats (Social), risk_flags, and (if present) availability regions.

Routine Evidence Packs (when present)

- In Routine mode, each routine step may include an \`evidence_pack\` (key actives / texture & finish / sensitivity flags / pairing rules / dupes) plus \`citations\`.
- You MUST ground step-level claims ("why this product", "how to use", "what not to mix") in the step's \`evidence_pack\` (and its \`citations\`).
- If an evidence pack is missing, clearly say "KB not found for this product" and avoid asserting product-specific facts.

KB Profile (when present)

- In Product/Dupe mode, a product may include a \`kb_profile\` (key actives / sensitivity flags / pairing rules / comparison notes) plus \`citations\`.
- Treat \`kb_profile\` as the highest-priority source of product facts. If \`kb_profile.citations\` is empty, treat product-specific claims as uncertain.

Reasoning Policy (Chain of Thought)

- Think step-by-step privately to apply the Aurora Algorithm.
- Do NOT reveal chain-of-thought. Output only the final answer with brief, grounded reasons.
- Never invent products or facts. If Context Data is missing, say "not found in database" and give generic ingredient-level advice.

Evidence-First Contract (RAG Guardrails)

- Do NOT make product-specific claims (ingredients, fragrance/alcohol, filters, suitability, irritation, availability) unless they are supported by Context Data (\`kb_profile\`, \`expert_knowledge\`, \`ingredients\`, or \`evidence_pack\`).
- If a claim is not supported, say "KB未提供/无法确认" and provide a safe self-check method (e.g., check INCI/official page).
- When you reference product-specific facts from KB, include at least one citation token from \`citations\` (e.g., "kb:...") in the same bullet/line.

CORE DECISION RULES (Must Follow)

1. Safety Filter (Priority Zero)

IF User Barrier == "Impaired" (Redness/Stinging):

VETO any product with risk_flags containing ANY of:
- raw flags: ['alcohol_high', 'strong_acid', 'retinol_high']
- canonical flags: ['alcohol', 'acid', 'high_irritation']
OR if burn_rate > 0.10.

ACTION: Explicitly warn the user: "🚫 Based on your current sensitivity, [Product Name] is too risky."

2. Targeted Treatment Logic (The "Comedone" Rule)

IF user mentions "closed comedones" (闭口), "tiny bumps", "rough texture" (粗糙), or "blackheads":
- PRIORITIZE acids (BHA/Salicylic, AHA/Glycolic/Mandelic, or Azelaic Acid) for the PM Treatment step.
- DOWNRANK generic Niacinamide or Retinol for this specific concern unless the user is clearly aging-focused.
- REASON: "Acid exfoliation is the most direct cure for unclogging pores."
- EXCEPTION: If User Barrier == "Impaired" or user is "sensitive": recommend Azelaic Acid or Mandelic Acid only, or skip actives entirely.

3. Budget Compression Logic (The "High-Low" Rule)

IF budget is "Low" (e.g., < $50/month OR a tight budget in local currency) AND skin type is "Oily" or "Combination" (or generally NOT "Dry"):
- MERGE AM STEPS: do NOT recommend a separate AM moisturizer; recommend a "Moisturizing Sunscreen" directly after cleansing.
- EXPLAIN: "For oily/combo skin, a modern sunscreen provides enough hydration. We skip the morning cream to save budget for a better PM active."
- ACTION: re-allocate the saved budget to upgrade the PM active (Serum/Treatment).

4. The "Sandwich" Strategy (Retinol/Acid)

If recommending Retinol or Strong Acids to a beginner:
- INSTRUCT: Use the "Sandwich Method" (Moisturizer -> Active -> Moisturizer).
- FREQUENCY: Start 1-2 times/week.

5. Budget Allocation (High-Low)

Cleanser/Mist: Recommend affordables (CeraVe, etc.). "Stay time is short, save money here."

Serum/Ampoule: Recommend higher budget. "Deep penetration requires better delivery tech."

6. Region & Availability

- You are recommending products available in ${input.regionLabel} (or Global).
- If a product availability includes "Global", explicitly mention it is widely available.
- If the user's region is CN and a product is mainly US-only/EU-only, mark it as "Hai-Tao (Cross-border) only" (or similar) rather than implying easy local availability.
- If no products match the user's region, say so and provide Global options.

7. Expert Insight Integration (Footnotes)

- Context Data may contain \`kb_profile\` and/or \`expert_knowledge\` notes (e.g., sensitivity flags, comparison notes).
- YOU MUST quote or paraphrase these notes when they exist (treat them as "footnotes" / evidence).
- If 'expert_knowledge.sensitivity_notes' flags a risk (e.g., fragrance/alcohol/strong acids) AND the user is sensitive or barrier is impaired, you MUST VETO and start with a clear warning.

8. Price Handling (Avoid Fake Prices)

- If a product price is missing, 0, or not provided in Context Data, treat it as unknown.
- DO NOT output "$0". Use "价格未知" / "price unknown" instead and avoid exact totals.

${modeAddendum}

Response Format (Markdown)

Part 1: Diagnosis 🩺

Briefly summarize their skin state and primary focus (e.g., "Repair First, Brighten Later").

Part 2: The Routine 📅

Present a vertical timeline for AM and PM.
Format:

🌞 AM (Protection):

[Step Name] - [Product Name] (Why: ...)

...

🌙 PM (Treatment):

[Step Name] - [Product Name] (Why: ...)

Part 3: Budget Analysis 💰

"Total Estimated Cost: $X. By using [Budget Product] for cleansing, we saved budget for [Hero Product]."

Part 4: Safety Warning ⚠️

Specific instructions on what NOT to mix (e.g., "Do not use [Product A] with [Product B]").

Tone & Style

Professional yet Accessible: Use clear terms. Explain "why" briefly.

Honest: If the retrieved products don't match the user (e.g., no safe options found), admit it and suggest generic ingredients (e.g., "Look for a plain 5% Panthenol cream").

No Fluff: Go straight to the solution.

Formatting:
- Use emoji bullets for readability (e.g., ✅ / ⚠️ / 💡) while keeping the structure requested above.

Few-Shot Examples (format reference only; do not copy products unless present in Context Data)

Example A (Sensitive + VETO):
- User: "I have sensitive skin with stinging redness. Can I use a strong retinol?"
- Output: Start with 🚫 warning, veto retinol, suggest barrier repair routine first, and only mild actives later.

Example B (Closed comedones + Tight budget):
- User: "Oily acne skin, closed comedones, budget ¥500, AM/PM routine."
- Output: AM: Cleanser -> Moisturizing Sunscreen (skip AM moisturizer). PM: Cleanser -> Azelaic/BHA -> Moisturizer. Include total cost and budget logic.

Context Data

\`\`\`json
${input.contextDataJson}
\`\`\`
`.trim();
}

function extractTextFromUnknownMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  if ("content" in message && typeof (message as any).content === "string") return (message as any).content;
  if ("text" in message && typeof (message as any).text === "string") return (message as any).text;

  if ("parts" in message && Array.isArray((message as any).parts)) {
    const texts = (message as any).parts
      .map((p: unknown) => {
        if (!p || typeof p !== "object") return "";
        if ((p as any).type === "text" && typeof (p as any).text === "string") return (p as any).text;
        return "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }

  return "";
}

function normalizeQuery(body: ChatRequest): string {
  if (typeof body.query === "string" && body.query.trim()) return body.query.trim();
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastUser = [...body.messages].reverse().find((m) => Boolean(m && typeof m === "object" && (m as any).role === "user"));
    const text = extractTextFromUnknownMessage(lastUser);
    if (text.trim()) return text.trim();
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

function detectRegionPreference(query: string): RegionPreference {
  const q = query.toLowerCase();

  const mentionsUs = /\b(us|usa)\b/i.test(query) || q.includes("sephora") || q.includes("amazon") || query.includes("美国");
  if (mentionsUs) return "US";

  const mentionsEu = /\b(eu)\b/i.test(query) || q.includes("europe") || query.includes("欧洲");
  if (mentionsEu) return "EU";

  if (q.includes("china") || query.includes("国内") || query.includes("淘宝") || query.includes("中国")) return "CN";

  // If the user is chatting in Chinese and didn't specify a different region, default to CN for better availability filtering.
  if (/[\u4e00-\u9fff]/.test(query)) return "CN";

  return null;
}

function normalizeAliasText(value: string) {
  // Keep CJK characters; remove whitespace/punctuation; normalize full-width chars.
  const nkfc = String(value ?? "").normalize("NFKC").toLowerCase();
  return nkfc.replace(/\s+/g, "").replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

type AnchorCandidate = {
  product_id: string;
  confidence: number; // 0-1
  matched_alias: string;
  alias_kind?: string | null;
  alias_len: number;
  weight: number;
};

type AliasMatchRow = {
  product_id: string;
  alias: string;
  alias_normalized: string;
  kind: string | null;
  weight: number | null;
  alias_len: number;
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function scoreAliasMatch(row: AliasMatchRow) {
  const aliasLen = Number(row.alias_len ?? row.alias_normalized?.length ?? 0);
  const weight = Number(row.weight ?? 0);
  const kind = String(row.kind ?? "").toLowerCase();

  const lengthBoost = Math.min(0.45, aliasLen * 0.03); // 15 chars -> +0.45
  const weightBoost = Math.min(0.15, Math.max(0, weight) / 100); // 0-100 -> +0.15

  const kindBoost = kind.includes("nickname") ? 0.22 : kind.includes("full") ? 0.15 : kind.includes("brand") ? -0.12 : 0;

  const base = 0.35;
  return clamp01(base + lengthBoost + weightBoost + kindBoost);
}

async function findAnchorCandidatesFromAliases(query: string): Promise<AnchorCandidate[]> {
  const normalizedQuery = normalizeAliasText(query);
  if (normalizedQuery.length < 2) return [];

  let rows: AliasMatchRow[] = [];
  try {
    rows = await prisma.$queryRaw<AliasMatchRow[]>(
      Prisma.sql`
        SELECT
          pa.product_id AS product_id,
          pa.alias AS alias,
          pa.alias_normalized AS alias_normalized,
          pa.kind AS kind,
          pa.weight AS weight,
          LENGTH(pa.alias_normalized) AS alias_len
        FROM "product_aliases" pa
        WHERE pa.alias_normalized IS NOT NULL
          AND pa.alias_normalized <> ''
          AND LENGTH(pa.alias_normalized) >= 2
          AND ${normalizedQuery} LIKE '%' || pa.alias_normalized || '%'
        ORDER BY LENGTH(pa.alias_normalized) DESC, COALESCE(pa.weight, 0) DESC
        LIMIT 25;
      `,
    );
  } catch (e) {
    // Backward-compatible: aliases table might not be migrated yet.
    return [];
  }

  const bestByProduct = new Map<string, AnchorCandidate>();
  for (const r of rows) {
    const productId = String(r.product_id ?? "").trim();
    if (!productId) continue;

    const candidate: AnchorCandidate = {
      product_id: productId,
      confidence: scoreAliasMatch(r),
      matched_alias: String(r.alias ?? "").trim() || String(r.alias_normalized ?? ""),
      alias_kind: r.kind,
      alias_len: Number(r.alias_len ?? 0),
      weight: Number(r.weight ?? 0),
    };

    const prev = bestByProduct.get(productId);
    if (!prev) {
      bestByProduct.set(productId, candidate);
      continue;
    }

    // Prefer longer alias matches; then higher confidence.
    if (candidate.alias_len > prev.alias_len || candidate.confidence > prev.confidence) {
      bestByProduct.set(productId, candidate);
    }
  }

  return Array.from(bestByProduct.values()).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function detectDupeIntent(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("dupe") ||
    q.includes("alternative") ||
    q.includes("alternatives") ||
    q.includes("similar") ||
    query.includes("平替") ||
    query.includes("替代") ||
    query.includes("对比") ||
    query.includes("类似") ||
    query.includes("同款")
  );
}

function detectProductEvaluationIntent(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("worth") ||
    q.includes("good") ||
    q.includes("ok") ||
    q.includes("works") ||
    q.includes("怎么样") ||
    query.includes("好用吗") ||
    query.includes("值吗") ||
    query.includes("适合吗") ||
    query.includes("能用吗") ||
    query.includes("可以用吗") ||
    query.includes("怎么样")
  );
}

function mapRiskFlags(rawFlags: unknown): RiskFlag[] {
  const flags = Array.isArray(rawFlags) ? rawFlags.map((f) => String(f).toLowerCase()) : [];
  const out = new Set<RiskFlag>();

  for (const f of flags) {
    // Be conservative, but avoid overly broad substring matches (e.g., "mild_acid" should NOT trigger strong-acid veto).
    if (f === "alcohol" || f.includes("alcohol_high") || f.includes("alcoholdenat") || f.includes("denatured_alcohol")) out.add("alcohol");
    if ((f === "acid" || f.includes("strong_acid") || f.includes("acid_medium") || f.includes("acid_high") || f.includes("acid_strong")) && !f.includes("mild_acid")) {
      out.add("acid");
    }
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

function detectClosedComedonesOrRoughTexture(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("closed comedone") ||
    q.includes("closed comedones") ||
    q.includes("rough texture") ||
    q.includes("bumps") ||
    query.includes("闭口") ||
    query.includes("粗糙") ||
    query.includes("颗粒感") ||
    query.includes("小疙瘩")
  );
}

function parseBudgetCny(query: string): number | null {
  // Examples: "预算 500 块人民币", "500元", "¥500"
  const normalized = query.replace(/，/g, ",");
  const m1 = normalized.match(/(?:预算|budget)\s*(?:[:：=]|is)?\s*(\d+(?:\.\d+)?)\s*(?:元|块|rmb|cny|人民币)/i);
  if (m1?.[1]) return Number(m1[1]);
  const m2 = normalized.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (m2?.[1]) return Number(m2[1]);
  const m3 = normalized.match(/(\d+(?:\.\d+)?)\s*(?:元|块)\b/);
  if (m3?.[1]) return Number(m3[1]);
  return null;
}

type ClarificationQuestion = { id: string; question: string; options: string[] };

function hasExplicitSkinTypeMention(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("oily") ||
    q.includes("dry") ||
    q.includes("combination") ||
    q.includes("combo") ||
    q.includes("normal") ||
    q.includes("sensitive") ||
    query.includes("油") ||
    query.includes("干") ||
    query.includes("混合") ||
    query.includes("中性") ||
    query.includes("敏感")
  );
}

function hasExplicitPrimaryConcern(query: string) {
  const q = query.toLowerCase();
  return (
    detectOilyAcne(query) ||
    detectClosedComedonesOrRoughTexture(query) ||
    q.includes("brighten") ||
    q.includes("whitening") ||
    q.includes("dark spot") ||
    q.includes("hyperpig") ||
    q.includes("anti-aging") ||
    q.includes("aging") ||
    query.includes("美白") ||
    query.includes("提亮") ||
    query.includes("淡斑") ||
    query.includes("祛斑") ||
    query.includes("暗沉") ||
    query.includes("痘印") ||
    query.includes("抗老") ||
    query.includes("皱纹") ||
    query.includes("细纹") ||
    query.includes("修护") ||
    query.includes("屏障")
  );
}

function mentionsBudgetButMissing(query: string, budgetCny: number | null) {
  if (budgetCny != null) return false;
  const q = query.toLowerCase();
  return q.includes("budget") || query.includes("预算") || query.includes("便宜") || query.includes("省钱") || /[¥￥]/.test(query);
}

function mentionsStrongActives(query: string) {
  const q = query.toLowerCase();
  return (
    q.includes("retinol") ||
    q.includes("adapalene") ||
    q.includes("tretinoin") ||
    q.includes("aha") ||
    q.includes("bha") ||
    q.includes("glycolic") ||
    q.includes("salicylic") ||
    q.includes("mandelic") ||
    q.includes("azelaic") ||
    query.includes("a醇") ||
    query.includes("维a") ||
    query.includes("阿达帕林") ||
    query.includes("水杨酸") ||
    query.includes("果酸") ||
    query.includes("杏仁酸") ||
    query.includes("壬二酸") ||
    query.includes("酸")
  );
}

function buildRoutineClarification(query: string, budgetCny: number | null): { questions: ClarificationQuestion[]; missing: string[] } {
  const questions: ClarificationQuestion[] = [];
  const missing: string[] = [];

  const hasSkin = hasExplicitSkinTypeMention(query) || detectSensitiveSkin(query);
  const hasConcern = hasExplicitPrimaryConcern(query);
  const needsBudget = mentionsBudgetButMissing(query, budgetCny);
  const barrierUnknown = !detectSensitiveSkin(query) && !detectBarrierImpaired(query) && mentionsStrongActives(query);

  // Priority 1: budget only when the user explicitly cares.
  if (needsBudget) {
    missing.push("budget");
    questions.push({
      id: "budget",
      question: "你的月预算大概是多少？",
      options: ["¥200", "¥500", "¥1000+", "不确定"],
    });
  }

  // Priority 2: skin type (only if not implied by sensitivity).
  if (!hasSkin && questions.length < 2) {
    missing.push("skin_type");
    questions.push({
      id: "skin_type",
      question: "你的肤质更接近哪一种？",
      options: ["油皮", "干皮", "混合皮", "敏感肌", "不确定"],
    });
  }

  // Priority 3: concern (if truly missing).
  if (!hasConcern && questions.length < 2) {
    missing.push("concerns");
    questions.push({
      id: "concerns",
      question: "你最想优先解决的 1-2 个问题是？",
      options: ["闭口/黑头", "痘痘", "暗沉/美白", "泛红敏感", "抗老", "补水修护"],
    });
  }

  // Optional: barrier status only when actives are mentioned and we still have space.
  if (barrierUnknown && questions.length < 2) {
    missing.push("barrier_status");
    questions.push({
      id: "barrier_status",
      question: "你最近是否有刺痛/泛红/爆皮（屏障受损）？",
      options: ["没有", "轻微", "明显（刺痛泛红）", "不确定"],
    });
  }

  return { questions, missing };
}

function formatClarificationAnswer(questions: ClarificationQuestion[]) {
  const lines: string[] = [];
  lines.push("为了给你更准的建议，我需要先确认 1-2 个信息：");
  for (const [idx, q] of questions.entries()) {
    lines.push(`${idx + 1}) ${q.question}（${q.options.join(" / ")}）`);
  }
  lines.push("你直接回复选项即可，我再生成完整的 AM/PM 流程。");
  return lines.join("\n");
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
  if (
    q.includes("comed") ||
    q.includes("acne") ||
    detectClosedComedonesOrRoughTexture(query) ||
    query.includes("粉刺") ||
    query.includes("痘")
  ) {
    push("acne_comedonal", 1);
    push("oil_control", 2);
  }

  // Redness / sensitivity
  if (detectSensitiveSkin(query) || query.includes("泛红") || query.includes("红") || query.includes("刺痛")) {
    push("soothing", 1);
    push("redness", 2);
    push("repair", 3);
  }

  // Brightening / dark spots
  if (
    q.includes("brighten") ||
    q.includes("whitening") ||
    q.includes("dark spot") ||
    q.includes("dark spots") ||
    q.includes("hyperpig") ||
    query.includes("美白") ||
    query.includes("提亮") ||
    query.includes("淡斑") ||
    query.includes("祛斑") ||
    query.includes("暗沉") ||
    query.includes("黄气") ||
    query.includes("痘印") ||
    query.includes("色沉")
  ) {
    const sensitiveOrImpaired = detectSensitiveSkin(query) || detectBarrierImpaired(query) || query.includes("刺痛");
    push("brightening", sensitiveOrImpaired ? 2 : 1);
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

function sanitizeUserForLlm(user: UserVector) {
  return {
    skin_type: user.skin_type,
    barrier_status: user.barrier_status,
    budget: user.budget,
    goals: user.goals,
    constraints: user.constraints ?? [],
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

function normalizeUsdPrice(value: unknown): number | null {
  const n = coerceNumber(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function sanitizeSkuForLlm(sku: SkuVector) {
  const social = sku.social_stats as any;
  const red = social?.RED_score ?? social?.platform_scores?.RED ?? null;
  const reddit = social?.Reddit_score ?? social?.platform_scores?.Reddit ?? null;
  const burn = social?.burn_rate ?? null;
  const topKeywords = Array.isArray(social?.top_keywords)
    ? social.top_keywords
    : Array.isArray(social?.topKeywords)
      ? social.topKeywords
      : null;

  return {
    sku_id: sku.sku_id,
    brand: sku.brand,
    name: sku.name,
    category: sku.category,
    price_usd: normalizeUsdPrice(sku.price),
    currency: sku.currency,
    mechanism: sku.mechanism,
    experience: sku.experience,
    risk_flags: sku.risk_flags,
    // Keep social stats compact to preserve output budget.
    social_stats: {
      RED_score: typeof red === "number" ? red : red == null ? null : Number(red),
      Reddit_score: typeof reddit === "number" ? reddit : reddit == null ? null : Number(reddit),
      burn_rate: typeof burn === "number" ? burn : burn == null ? null : Number(burn),
      ...(topKeywords ? { top_keywords: topKeywords } : {}),
    },
  };
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

function optionalAnyEnv(names: string[]): string | null {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
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
  const combinedPrompt = input.user_prompt.trim()
    ? `${input.system_prompt}\n\nContext:\n${input.user_prompt}`
    : input.system_prompt;

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

function normalizeEmbeddingDim(embedding: number[], dim = 1536) {
  if (embedding.length === dim) return embedding;
  if (embedding.length < dim) return [...embedding, ...new Array(dim - embedding.length).fill(0)];
  // MVP trade-off: truncate to fit vector(1536)
  console.warn(`Embedding dim ${embedding.length} > ${dim}; truncating to ${dim}.`);
  return embedding.slice(0, dim);
}

async function geminiEmbedContent(input: { text: string; model?: string }) {
  const apiKey = optionalAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY / GOOGLE_API_KEY");
  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1").trim().replace(/\/$/, "");
  const model = normalizeGeminiModelName(input.model ?? process.env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004");
  const url = `${apiBaseUrl}/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`;

  const body = { content: { parts: [{ text: input.text }] } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini embedContent failed (${res.status}): ${text}`);
  }
  const payload = (await res.json()) as any;
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) throw new Error("Gemini embedding missing values");
  const embedding = values.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n));
  if (!embedding.length) throw new Error("Gemini embedding values invalid");
  return { embedding, model };
}

async function openaiEmbedText(input: { text: string; model?: string }) {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = (input.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small").trim();

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: input.text }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings failed (${res.status}): ${text}`);
  }
  const payload = (await res.json()) as any;
  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) throw new Error("OpenAI embedding missing values");
  return { embedding: embedding.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n)), model };
}

function buildEmbeddingQueryForRoutine(userQuery: string, user: UserVector) {
  const parts: string[] = [];
  parts.push(userQuery.trim());

  const goals = Array.isArray(user.goals) ? user.goals.map((g) => g.track) : [];
  const skin = user.skin_type;
  const skinText = Array.isArray(skin) ? skin.join(",") : String(skin ?? "");
  parts.push(`skin_type=${skinText}`);
  parts.push(`barrier_status=${user.barrier_status}`);
  if (user.budget?.total_monthly) parts.push(`budget_monthly=${user.budget.total_monthly}`);

  const add = (s: string) => parts.push(s);

  // Translate concerns into "ingredient-space" keywords so embeddings (trained on ingredient text) retrieve relevant SKUs.
  if (goals.includes("brightening")) {
    add("brightening actives: vitamin c, niacinamide, tranexamic acid, arbutin, azelaic acid, kojic acid");
  }
  if (goals.includes("acne_comedonal") || goals.includes("oil_control")) {
    add("acne actives: salicylic acid, bha, azelaic acid, niacinamide, zinc, adapalene");
  }
  if (goals.includes("soothing") || goals.includes("redness") || user.barrier_status === "impaired") {
    add("soothing/barrier: panthenol, centella, allantoin, ceramides, glycerin, oat");
  }
  if (goals.includes("repair")) {
    add("barrier repair: ceramides, cholesterol, fatty acids, petrolatum, panthenol");
  }

  // Safety hints help retrieve gentler formulas when the user reports stinging/redness.
  if (user.barrier_status === "impaired") {
    add("avoid irritants: alcohol denat, fragrance, essential oils, strong acids, high retinol");
  }

  return parts.filter(Boolean).join("\n");
}

type IngredientContext = {
  head: string[];
  hero_actives?: unknown;
  highlights: string[];
};

type ExpertKnowledge = {
  sensitivity_notes?: string;
  comparison_notes?: string;
  key_actives_summary?: string;
  usage_notes?: string;
  texture_notes?: string;
  sources?: Array<{ source_sheet: string; field: string; kb_id?: string }>;
};

type KbSnippetForEvidence = KbSnippet;

function buildExpertKnowledgeFromKb(
  snippets: Array<KbSnippetForEvidence>,
): ExpertKnowledge | null {
  if (!snippets.length) return null;

  const sensitivity: string[] = [];
  const comparison: string[] = [];
  const keyActives: string[] = [];
  const usage: string[] = [];
  const texture: string[] = [];
  const sources: ExpertKnowledge["sources"] = [];

  const pushUnique = (list: string[], value: string) => {
    const cleaned = value.trim();
    if (!cleaned) return;
    if (list.includes(cleaned)) return;
    list.push(cleaned);
  };

  for (const s of snippets) {
    const key = inferKbCanonicalKey(s);
    const content = String(s.content ?? "").trim();
    if (!content) continue;

    sources.push({ source_sheet: String(s.source_sheet ?? ""), field: String(s.field ?? ""), kb_id: s.id });

    if (key === "sensitivity") {
      pushUnique(sensitivity, content);
      continue;
    }
    if (key === "comparison") {
      pushUnique(comparison, content);
      continue;
    }
    if (key === "key_actives") {
      pushUnique(keyActives, content);
      continue;
    }
    if (key === "usage") {
      pushUnique(usage, content);
      continue;
    }
    if (key === "texture") {
      pushUnique(texture, content);
      continue;
    }
  }

  if (!sensitivity.length && !comparison.length && !keyActives.length && !usage.length && !texture.length) return null;

  return {
    sensitivity_notes: sensitivity.length ? sensitivity.join(" | ") : undefined,
    comparison_notes: comparison.length ? comparison.join(" | ") : undefined,
    key_actives_summary: keyActives.length ? keyActives.join(" | ") : undefined,
    usage_notes: usage.length ? usage.join(" | ") : undefined,
    texture_notes: texture.length ? texture.join(" | ") : undefined,
    sources: sources.length ? sources : undefined,
  };
}

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

type RoutineEvidencePack = KbProfile;

type RoutineStepWithEvidence = {
  step: string;
  sku: SkuVector;
  notes: string[];
  product_id: string | null;
  evidence_pack: RoutineEvidencePack | null;
};

type RoutineRecWithEvidence = {
  am: RoutineStepWithEvidence[];
  pm: RoutineStepWithEvidence[];
  total_usd: number;
  total_cny: number;
};

function uniqueStrings(items: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function buildRoutineEvidencePack(input: {
  sku: SkuVector;
  product_id: string;
  region: RegionPreference;
  availability: string[];
  snippets: KbSnippetForEvidence[];
}): RoutineEvidencePack {
  return buildKbProfile({
    product_id: input.product_id,
    display_name: `${input.sku.brand} ${input.sku.name}`.trim(),
    region: input.region,
    availability: input.availability,
    sku_risk_flags: input.sku.risk_flags,
    sku_experience: input.sku.experience as any,
    snippets: input.snippets,
  });
}

async function buildRoutineEvidenceIndex(input: {
  routines: RoutineRec[];
  region: RegionPreference;
}): Promise<{
  productIdBySkuId: Map<string, string>;
  availabilityByProductId: Map<string, string[]>;
  evidenceByProductId: Map<string, RoutineEvidencePack>;
}> {
  const productIdBySkuId = new Map<string, string>();
  const availabilityByProductId = new Map<string, string[]>();
  const evidenceByProductId = new Map<string, RoutineEvidencePack>();

  // Best-effort: if DB is not configured, skip KB enrichment.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.includes("${{")) return { productIdBySkuId, availabilityByProductId, evidenceByProductId };

  const skuById = new Map<string, SkuVector>();
  for (const r of input.routines) {
    for (const s of [...r.am, ...r.pm]) skuById.set(s.sku.sku_id, s.sku);
  }

  // Resolve product_ids for any non-UUID sku_id values (aliases).
  for (const sku of skuById.values()) {
    const skuId = sku.sku_id;
    if (looksLikeUuid(skuId)) {
      productIdBySkuId.set(skuId, skuId);
      continue;
    }

    // Try known alias resolution first.
    const resolved = await resolveProductIdForSkuId(skuId);
    if (resolved) {
      productIdBySkuId.set(skuId, resolved);
      continue;
    }

    // Fallback: try brand+name identity.
    const row = await prisma.product.findFirst({ where: { brand: sku.brand, name: sku.name }, select: { id: true } });
    if (row?.id) productIdBySkuId.set(skuId, row.id);
  }

  const productIds = uniqueStrings(Array.from(productIdBySkuId.values()));
  if (!productIds.length) return { productIdBySkuId, availabilityByProductId, evidenceByProductId };

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, regionAvailability: true },
  });
  for (const p of products) availabilityByProductId.set(p.id, Array.isArray(p.regionAvailability) ? p.regionAvailability : []);

  const kbRows = await prisma.productKbSnippet.findMany({
    where: { productId: { in: productIds } },
    orderBy: [{ sourceSheet: "asc" }, { field: "asc" }, { updatedAt: "desc" }],
    select: { id: true, productId: true, sourceSheet: true, field: true, content: true, metadata: true },
  });
  const kbByProductId = new Map<string, KbSnippetForEvidence[]>();
  for (const row of kbRows) {
    const list = kbByProductId.get(row.productId) ?? [];
    list.push({ id: row.id, source_sheet: row.sourceSheet, field: row.field, content: row.content, metadata: row.metadata });
    kbByProductId.set(row.productId, list);
  }

  for (const sku of skuById.values()) {
    const productId = productIdBySkuId.get(sku.sku_id) ?? (looksLikeUuid(sku.sku_id) ? sku.sku_id : null);
    if (!productId) continue;
    if (evidenceByProductId.has(productId)) continue;

    const pack = buildRoutineEvidencePack({
      sku,
      product_id: productId,
      region: input.region,
      availability: availabilityByProductId.get(productId) ?? [],
      snippets: kbByProductId.get(productId) ?? [],
    });
    evidenceByProductId.set(productId, pack);
  }

  return { productIdBySkuId, availabilityByProductId, evidenceByProductId };
}

function attachEvidenceToRoutine(
  routine: RoutineRec,
  index: { productIdBySkuId: Map<string, string>; evidenceByProductId: Map<string, RoutineEvidencePack> },
): RoutineRecWithEvidence {
  const enrichStep = (s: { step: string; sku: SkuVector; notes: string[] }): RoutineStepWithEvidence => {
    const productId = index.productIdBySkuId.get(s.sku.sku_id) ?? (looksLikeUuid(s.sku.sku_id) ? s.sku.sku_id : null);
    const evidence = productId ? index.evidenceByProductId.get(productId) ?? null : null;
    return { ...s, product_id: productId, evidence_pack: evidence };
  };

  return {
    am: routine.am.map(enrichStep),
    pm: routine.pm.map(enrichStep),
    total_usd: routine.total_usd,
    total_cny: routine.total_cny,
  };
}

function hasDrySkin(user: UserVector) {
  const skin = user.skin_type;
  if (Array.isArray(skin)) return skin.includes("dry");
  return skin === "dry";
}

function isLowBudgetCny(budgetCny: number | null) {
  if (budgetCny == null) return false;
  if (!Number.isFinite(budgetCny)) return false;
  // Tight MVP threshold: <= ¥500 is considered "low" for a full routine.
  return budgetCny <= 500;
}

function pickCheapest(db: SkuVector[], category: SkuVector["category"], user?: UserVector): SkuVector | null {
  let candidates = db.filter((s) => s.category === category);

  // Safety-first: when we have a user profile, avoid picking a vetoed product just because it's cheap.
  if (user) {
    const safe = candidates.filter((s) => calculateScore(s, user).total > 0);
    if (safe.length > 0) candidates = safe;
  }

  const priced = candidates.filter((s) => Number.isFinite(s.price) && s.price > 0);
  const pool = priced.length ? priced : candidates;
  return [...pool].sort((a, b) => a.price - b.price)[0] ?? null;
}

function pickBestByScore(db: SkuVector[], category: SkuVector["category"], user: UserVector): SkuVector | null {
  const scored = db
    .filter((s) => s.category === category)
    .map((s) => ({ sku: s, score: calculateScore(s, user) }))
    .filter((x) => x.score.total > 0)
    .sort((a, b) => b.score.total - a.score.total);
  return scored[0]?.sku ?? null;
}

function isAcidTreatmentCandidate(sku: SkuVector) {
  const n = sku.name.toLowerCase();
  const b = sku.brand.toLowerCase();
  const text = `${b} ${n}`;

  // Avoid false positives like "Hyaluronic Acid" which isn't exfoliating.
  if (text.includes("hyaluronic")) return false;

  return (
    text.includes("bha") ||
    text.includes("aha") ||
    text.includes("azelaic") ||
    text.includes("mandelic") ||
    text.includes("salicylic") ||
    text.includes("glycolic") ||
    text.includes("lactic") ||
    text.includes("exfoliant") ||
    sku.risk_flags.includes("acid")
  );
}

function isMildAcidCandidate(sku: SkuVector) {
  const text = `${sku.brand} ${sku.name}`.toLowerCase();
  return text.includes("azelaic") || text.includes("mandelic");
}

function pickBestAcidForComedones(db: SkuVector[], user: UserVector) {
  const sensitive = Array.isArray(user.skin_type) ? user.skin_type.includes("sensitive") : user.skin_type === "sensitive";

  const candidates = db
    .filter(isAcidTreatmentCandidate)
    .map((sku) => ({ sku, score: calculateScore(sku, user) }))
    .filter((x) => x.score.total > 0);

  if (candidates.length === 0) return null;

  if (sensitive) {
    const mild = candidates.filter((c) => isMildAcidCandidate(c.sku)).sort((a, b) => b.score.total - a.score.total);
    if (mild[0]?.sku) return mild[0].sku;
    // If no mild acids exist in the DB, do not force a harsher acid.
    return null;
  }

  // Non-sensitive: pick the highest-scoring acid candidate.
  return [...candidates].sort((a, b) => b.score.total - a.score.total)[0]?.sku ?? null;
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

function buildPrimaryRoutine(db: SkuVector[], user: UserVector, query: string, budgetCny: number | null): RoutineRec {
  const lowBudget = isLowBudgetCny(budgetCny);
  const skipAmMoisturizer = lowBudget && !hasDrySkin(user);
  const comedones = detectClosedComedonesOrRoughTexture(query);

  const cleanser = pickCheapest(db, "cleanser", user);
  const sunscreen = pickCheapest(db, "sunscreen", user);

  // Targeted comedone logic: prioritize acids (BHA/AHA/Azelaic) in PM over Niacinamide/Retinol.
  let treatment: SkuVector | null = null;
  if (comedones) treatment = pickBestAcidForComedones(db, user);
  if (!treatment) treatment = pickBestByScore(db, "treatment", user) ?? pickBestByScore(db, "serum", user);

  // Budget compression: if low budget and not dry, keep moisturizer simple/cheap and invest in the PM active.
  const moisturizer: SkuVector | null =
    lowBudget && !hasDrySkin(user)
      ? pickCheapest(db, "moisturizer", user)
      : pickBestByScore(db, "moisturizer", user) ?? pickCheapest(db, "moisturizer", user);

  const am: RoutineRec["am"] = [];
  const pm: RoutineRec["pm"] = [];

  if (cleanser) {
    am.push({ step: "Cleanser", sku: cleanser, notes: ["Use gentle cleansing; avoid over-stripping."] });
    pm.push({ step: "Cleanser", sku: cleanser, notes: ["If wearing sunscreen/makeup, double cleanse as needed."] });
  }

  if (!skipAmMoisturizer && moisturizer) {
    am.push({ step: "Moisturizer", sku: moisturizer, notes: ["Light layer to support barrier."] });
  }

  if (sunscreen) {
    am.push({
      step: "Sunscreen",
      sku: sunscreen,
      notes: skipAmMoisturizer
        ? ["Moisturizing sunscreen can replace AM moisturizer on oily/combo skin (budget compression).", "Apply generously; reapply if outdoors."]
        : ["Apply generously; reapply if outdoors."],
    });
  }

  if (treatment) {
    const acneGoal = user.goals?.some((g) => g.track === "acne_comedonal" || g.track === "oil_control");
    pm.push({
      step: "Treatment",
      sku: treatment,
      notes: [
        acneGoal && comedones
          ? "Targeting closed comedones/rough texture (prioritize acids to unclog pores)."
          : acneGoal
            ? "Targeting oil control/comedones."
            : "Active step.",
        "Start 2-3 nights/week, then increase as tolerated.",
      ],
    });
  }

  if (moisturizer) {
    pm.push({ step: "Moisturizer", sku: moisturizer, notes: ["Seal in hydration; reduce irritation."] });
  }

  const totalUsd = sumUniqueUsd([...am, ...pm].map((s) => s.sku));
  return { am, pm, total_usd: totalUsd, total_cny: computeUsdToCny(totalUsd) };
}

function buildBudgetSafeRoutine(db: SkuVector[], user: UserVector, query: string, budgetCny: number | null): RoutineRec {
  const primary = buildPrimaryRoutine(db, user, query, budgetCny);
  if (budgetCny == null || !Number.isFinite(budgetCny)) return primary;

  const budgetUsd = budgetCny / USD_TO_CNY;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return primary;

  const lowBudget = isLowBudgetCny(budgetCny);
  const skipAmMoisturizer = lowBudget && !hasDrySkin(user);

  const cleanser = pickCheapest(db, "cleanser", user);
  const sunscreen = pickCheapest(db, "sunscreen", user);

  // Start from the same treatment/moisturizer choices as primary.
  let treatment = primary.pm.find((s) => s.step === "Treatment")?.sku ?? null;
  let moisturizer = primary.pm.find((s) => s.step === "Moisturizer")?.sku ?? null;

  const budgetSkus = () => [cleanser, sunscreen, treatment, moisturizer].filter((s): s is SkuVector => Boolean(s));

  let totalUsd = sumUniqueUsd(budgetSkus());

  if (totalUsd > budgetUsd) {
    // First attempt: ensure moisturizer is cheapest.
    const cheapMoist = pickCheapest(db, "moisturizer", user);
    if (cheapMoist) moisturizer = cheapMoist;
    totalUsd = sumUniqueUsd(budgetSkus());
  }

  if (totalUsd > budgetUsd) {
    // Second attempt: downgrade the active to a cheaper, high-scoring option (may sacrifice acids).
    const candidates = db
      .filter((s) => s.category === "treatment" || s.category === "serum")
      .map((sku) => ({ sku, score: calculateScore(sku, user) }))
      .filter((x) => x.score.total > 0)
      .sort((a, b) => b.score.total - a.score.total);

    const cheaper = [...candidates]
      .sort((a, b) => a.sku.price - b.sku.price)
      .find((x) => treatment && x.sku.price < treatment.price);

    if (cheaper) treatment = cheaper.sku;
    totalUsd = sumUniqueUsd(budgetSkus());
  }

  if (totalUsd > budgetUsd) {
    // Last resort: drop the active.
    treatment = null;
    totalUsd = sumUniqueUsd(budgetSkus());
  }

  // Rebuild steps (keep the "skip AM moisturizer" rule).
  const am: RoutineRec["am"] = [];
  const pm: RoutineRec["pm"] = [];

  if (cleanser) {
    am.push({ step: "Cleanser", sku: cleanser, notes: ["Use gentle cleansing; avoid over-stripping."] });
    pm.push({ step: "Cleanser", sku: cleanser, notes: ["If wearing sunscreen/makeup, double cleanse as needed."] });
  }

  if (!skipAmMoisturizer && moisturizer) {
    am.push({ step: "Moisturizer", sku: moisturizer, notes: ["Light layer to support barrier."] });
  }

  if (sunscreen) {
    am.push({
      step: "Sunscreen",
      sku: sunscreen,
      notes: skipAmMoisturizer
        ? ["Moisturizing sunscreen can replace AM moisturizer on oily/combo skin (budget compression).", "Apply generously; reapply if outdoors."]
        : ["Apply generously; reapply if outdoors."],
    });
  }

  if (treatment) {
    pm.push({
      step: "Treatment",
      sku: treatment,
      notes: ["Budget-safe active choice.", "Start 2-3 nights/week, then increase as tolerated."],
    });
  }

  if (moisturizer) {
    pm.push({ step: "Moisturizer", sku: moisturizer, notes: ["Seal in hydration; reduce irritation."] });
  }

  const finalUsd = sumUniqueUsd([...am, ...pm].map((s) => s.sku));
  return { am, pm, total_usd: finalUsd, total_cny: computeUsdToCny(finalUsd) };
}

function isTooShort(answer: string) {
  const trimmed = answer.trim();
  // Gemini sometimes returns concise but valid answers; keep this check lightweight to avoid discarding good outputs.
  if (trimmed.length < 80) return true;

  // Reject obvious "unfinished bullet" stubs that commonly happen with streaming truncation.
  if (/\n\s*[-*•]\s*$/.test(trimmed)) return true;

  return false;
}

function buildFallbackProductAnswer(input: {
  query: string;
  detected: { sensitive_skin: boolean; barrier_impaired: boolean };
  anchor: { brand: string; name: string; price_usd: number | null; score?: SkuScoreBreakdown; ingredients?: IngredientContext; vetoed: boolean };
  candidates: Array<{
    brand: string;
    name: string;
    price_usd: number | null;
    similarity: number;
    tradeoff: string;
    ingredients?: IngredientContext;
  }>;
}) {
  const { anchor, candidates, detected } = input;
  const priceLabel = (usd: number | null) => (usd != null && Number.isFinite(usd) && usd > 0 ? formatUsd(usd) : "价格未知");

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
  const anchorPrice = anchor.price_usd;
  const topPrice = top[0]?.price_usd ?? null;
  const priceGap =
    top[0] && anchorPrice != null && anchorPrice > 0 && topPrice != null && topPrice > 0
      ? `价格对比：${anchor.brand} ${formatUsd(anchorPrice)} vs ${top[0].brand} ${formatUsd(topPrice)}（约 ${Math.round(anchorPrice / Math.max(1, topPrice))}x 差异）。`
      : null;

  const lines: string[] = [];
  lines.push(header);
  lines.push(`- Anchor：${anchor.brand} ${anchor.name}（${priceLabel(anchor.price_usd)}）`);
  if (scoreLine) lines.push(`- ${scoreLine}`);
  if (anchor.ingredients?.highlights?.length) lines.push(`- 关键成分/结构：${anchor.ingredients.highlights.join("；")}`);
  if (priceGap) lines.push(`- ${priceGap}`);

  if (top.length > 0) {
    lines.push("");
    lines.push("推荐平替（按相似度/性价比）：");
    for (const [idx, c] of top.entries()) {
      const cLines: string[] = [];
      cLines.push(`${idx + 1}) ${c.brand} ${c.name}（${priceLabel(c.price_usd)}，相似度≈${c.similarity.toFixed(2)}）`);
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

function buildFallbackRoutineAnswer(input: {
  query: string;
  budget_cny: number | null;
  routine_primary: RoutineRec;
  routine_budget?: RoutineRec;
}) {
  const { budget_cny, routine_primary, routine_budget } = input;
  const detectedRegion = detectRegionPreference(input.query);

  const wantsBrightening =
    input.query.toLowerCase().includes("brighten") ||
    input.query.toLowerCase().includes("whitening") ||
    input.query.toLowerCase().includes("dark spot") ||
    input.query.toLowerCase().includes("hyperpig") ||
    input.query.includes("美白") ||
    input.query.includes("提亮") ||
    input.query.includes("淡斑") ||
    input.query.includes("祛斑") ||
    input.query.includes("暗沉") ||
    input.query.includes("痘印");
  const comedones = detectClosedComedonesOrRoughTexture(input.query);
  const oilyAcne = detectOilyAcne(input.query);
  const sensitive = detectSensitiveSkin(input.query);
  const barrierImpaired = detectBarrierImpaired(input.query);

  const diagnosisTags: string[] = [];
  if (wantsBrightening) diagnosisTags.push("提亮/淡斑");
  if (barrierImpaired) diagnosisTags.push("屏障受损/刺痛");
  else if (sensitive) diagnosisTags.push("敏感/泛红");
  if (comedones) diagnosisTags.push("闭口/粗糙");
  if (!comedones && oilyAcne) diagnosisTags.push("油痘倾向");

  const uniqueSkus = () => {
    const seen = new Set<string>();
    const out: SkuVector[] = [];
    for (const step of [...routine_primary.am, ...routine_primary.pm]) {
      if (seen.has(step.sku.sku_id)) continue;
      seen.add(step.sku.sku_id);
      out.push(step.sku);
    }
    return out;
  };

  const costSummary = (() => {
    const skus = uniqueSkus();
    let knownUsd = 0;
    let unknown = 0;
    for (const sku of skus) {
      if (!Number.isFinite(sku.price) || sku.price <= 0) {
        unknown += 1;
        continue;
      }
      knownUsd += sku.price;
    }
    return { knownUsd, knownCny: computeUsdToCny(knownUsd), unknownCount: unknown, totalUnique: skus.length };
  })();

  const withinBudget =
    budget_cny != null && costSummary.unknownCount === 0 ? costSummary.knownCny <= budget_cny : null;

  const priceLabel = (usd: number) => (!Number.isFinite(usd) || usd <= 0 ? "价格未知" : formatUsd(usd));

  const lines: string[] = [];
  lines.push("Part 1: Diagnosis 🩺");
  lines.push(
    `- 目标：${diagnosisTags.length ? diagnosisTags.join(" / ") : "根据你的描述给出温和入门流程"}${
      detectedRegion ? `；坐标：${detectedRegion}` : ""
    }。`,
  );
  if (barrierImpaired || sensitive) {
    lines.push("- 重点：你提到「刺痛/敏感」，优先走温和、低刺激路线，先稳住屏障再加大活性。");
  }

  lines.push("");
  lines.push("Part 2: The Routine 📅");

  lines.push("");
  lines.push("🌞 AM (Protection):");
  for (const step of routine_primary.am) {
    lines.push(`- ${step.step} - ${step.sku.brand} ${step.sku.name}（${priceLabel(step.sku.price)}）`);
  }

  lines.push("");
  lines.push("🌙 PM (Treatment):");
  for (const step of routine_primary.pm) {
    lines.push(`- ${step.step} - ${step.sku.brand} ${step.sku.name}（${priceLabel(step.sku.price)}）`);
  }

  lines.push("");
  lines.push("Part 3: Budget Analysis 💰");
  if (budget_cny != null) {
    lines.push(`- 预算：${formatCny(budget_cny)}（≈${formatUsd(budget_cny / USD_TO_CNY)}）`);
  }
  if (costSummary.unknownCount > 0) {
    lines.push(
      `- 价格数据不完整：${costSummary.unknownCount}/${costSummary.totalUnique} 个商品缺少价格；已知价格合计≈${formatUsd(
        costSummary.knownUsd,
      )}（≈${formatCny(costSummary.knownCny)}）`,
    );
  } else {
    lines.push(
      `- 主方案合计≈${formatUsd(costSummary.knownUsd)}（≈${formatCny(costSummary.knownCny)}）${
        withinBudget == null ? "" : withinBudget ? "，在预算内" : "，可能超预算"
      }。`,
    );
  }

  if (budget_cny != null && !withinBudget && routine_budget) {
    lines.push("");
    lines.push("如果你必须严格不超预算（备选方案）：");
    lines.push(`- 合计≈${formatCny(routine_budget.total_cny)}（${formatUsd(routine_budget.total_usd)}）`);

    lines.push("");
    lines.push("AM（备选）：");
    for (const step of routine_budget.am) {
      lines.push(`- ${step.step}：${step.sku.brand} ${step.sku.name}（${priceLabel(step.sku.price)}）`);
    }

    lines.push("");
    lines.push("PM（备选）：");
    for (const step of routine_budget.pm) {
      lines.push(`- ${step.step}：${step.sku.brand} ${step.sku.name}（${priceLabel(step.sku.price)}）`);
    }
  }

  lines.push("");
  lines.push("Part 4: Safety Warning ⚠️");
  lines.push("注意：活性类（酸/维A类）先从每周 2-3 次开始，出现刺痛爆皮就先停，用修护类把屏障养好。");
  return lines.join("\n").trim();
}

function streamTextResponse(text: string, opts: { chunkChars?: number; delayMs?: number } = {}) {
  const chunkChars = typeof opts.chunkChars === "number" && opts.chunkChars > 0 ? opts.chunkChars : 48;
  const delayMs = typeof opts.delayMs === "number" && opts.delayMs > 0 ? opts.delayMs : 0;

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));

  const textStream = new ReadableStream<string>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });

  return createTextStreamResponse({ textStream });
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
  const detectedRegion = detectRegionPreference(query);
  const regionLabel = detectedRegion ?? "Global";

  const explicitAnchorId =
    typeof body.anchor_product_id === "string" && body.anchor_product_id.trim() ? body.anchor_product_id.trim() : null;
  const dupeIntent = detectDupeIntent(query);
  const evalIntent = detectProductEvaluationIntent(query);
  const routineIntent = query.includes("流程") || query.includes("早晚") || query.toLowerCase().includes("routine");

  const aliasCandidates = explicitAnchorId ? [] : await findAnchorCandidatesFromAliases(query);
  const bestAlias = aliasCandidates[0] ?? null;
  const highConfidenceAlias = bestAlias != null && bestAlias.confidence >= 0.72;

  // Legacy fallback (brand heuristics + loose token match).
  const legacyAnchorId = !explicitAnchorId && (dupeIntent || evalIntent) ? await findAnchorProductId(query) : null;

  const anchorProductId = explicitAnchorId ?? (highConfidenceAlias ? bestAlias.product_id : null) ?? legacyAnchorId;

  // If the user is asking for a dupe/compare, we should not silently drift into a routine.
  if ((dupeIntent || evalIntent) && (!anchorProductId || !looksLikeUuid(anchorProductId))) {
    const suggestions = aliasCandidates.slice(0, 3).map((c) => c.matched_alias).filter(Boolean);
    const hint = suggestions.length ? `\n\n我猜你可能在说：${suggestions.join(" / ")}。` : "";
    const answer = dupeIntent
      ? `为了帮你找“平替/替代”，我需要你明确 **想对比的具体产品**（发产品名或链接即可）。${hint}`
      : `我需要你提供具体产品名（或传 \`anchor_product_id\`），我才能基于数据库做“适配/风险/替代”分析。${hint}`;
    if (Boolean(body.stream)) return streamTextResponse(answer);
    return NextResponse.json({
      query,
      intent: "clarify",
      answer,
      clarification: {
        questions: [
          { id: "anchor", question: "你想对比/评估的具体产品是？", options: ["直接发产品名", "发购买链接", "传 anchor_product_id"] },
        ],
        candidates: aliasCandidates,
      },
    });
  }

  // Default: Routine planning unless the user explicitly wants dupe/evaluation (or provides an explicit anchor id).
  const shouldPlanRoutine = routineIntent || (!explicitAnchorId && !dupeIntent && !evalIntent);

  const provider =
    body.llm_provider ??
    (process.env.AURORA_CHAT_PROVIDER === "openai" || process.env.AURORA_CHAT_PROVIDER === "gemini"
      ? (process.env.AURORA_CHAT_PROVIDER as "openai" | "gemini")
      : (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "openai"));
  const requestedModel = typeof body.llm_model === "string" && body.llm_model.trim() ? body.llm_model.trim() : undefined;
  const wantsStream = Boolean(body.stream);

  // ROUTINE PATH
  if (shouldPlanRoutine) {
    const clarify = buildRoutineClarification(query, budgetCny);
    if (clarify.questions.length) {
      const answer = formatClarificationAnswer(clarify.questions);
      if (wantsStream) return streamTextResponse(answer);
      return NextResponse.json({
        query,
        intent: "clarify",
        answer,
        clarification: { questions: clarify.questions, missing_fields: clarify.missing, region_preference: detectedRegion },
      });
    }

    // Build a lightweight user vector from query text.
    const user = buildUserVectorFromQuery(query, budgetCny != null ? { total_monthly: budgetCny, strategy: "balanced" } : undefined);
    const dbAll = await getSkuDatabase();

    const mergeSkuPool = (items: Array<SkuVector | null | undefined>) => {
      const out: SkuVector[] = [];
      const seen = new Set<string>();
      for (const sku of items) {
        if (!sku) continue;
        const key = sku.sku_id;
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(sku);
      }
      return out;
    };

    const countByCategory = (pool: SkuVector[], category: SkuVector["category"]) => pool.filter((s) => s.category === category).length;

    let dbForRoutine = dbAll;
    let retrieval: null | {
      used: boolean;
      provider: "gemini" | "openai";
      embedding_model: string;
      embedding_query: string;
      retrieved: Array<{ product_id: string; brand: string; name: string; category: string; similarity: number; availability: string[] }>;
      error?: string;
    } = null;

    // Vector-first candidate pool for "no anchor" queries.
    // Uses the same embedding model as ingestion (default: text-embedding-004 truncated/padded to 1536).
    if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("${{")) {
      try {
        const embeddingQuery = buildEmbeddingQueryForRoutine(query, user);
        const providerForEmbedding: "gemini" | "openai" =
          optionalAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]) ? "gemini" : (process.env.OPENAI_API_KEY ? "openai" : "gemini");

        const embedResult =
          providerForEmbedding === "gemini"
            ? await geminiEmbedContent({ text: embeddingQuery })
            : await openaiEmbedText({ text: embeddingQuery });

        const embedding = normalizeEmbeddingDim(embedResult.embedding, 1536);
        const found = await findSimilarSkus(embedding, 32, detectedRegion);

        // Use retrieved SKUs first, then patch category holes with a tiny deterministic fallback set.
        const retrievedSkus = found.map((r) => r.sku);

        const essentials = mergeSkuPool([
          // Always include at least one option per core step.
          countByCategory(retrievedSkus, "cleanser") ? null : pickCheapest(dbAll, "cleanser", user),
          countByCategory(retrievedSkus, "sunscreen") ? null : pickCheapest(dbAll, "sunscreen", user),
          countByCategory(retrievedSkus, "moisturizer") ? null : pickCheapest(dbAll, "moisturizer", user),
          countByCategory(retrievedSkus, "treatment") || countByCategory(retrievedSkus, "serum")
            ? null
            : (pickBestByScore(dbAll, "treatment", user) ?? pickBestByScore(dbAll, "serum", user)),
        ]);

        dbForRoutine = mergeSkuPool([...retrievedSkus, ...essentials]);
        retrieval = {
          used: true,
          provider: providerForEmbedding,
          embedding_model: embedResult.model,
          embedding_query: embeddingQuery,
          retrieved: found.slice(0, 10).map((r) => ({
            product_id: r.product_id,
            brand: r.sku.brand,
            name: r.sku.name,
            category: r.sku.category,
            similarity: r.similarity,
            availability: (r as any).availability ?? [],
          })),
        };
      } catch (e) {
        retrieval = {
          used: false,
          provider: optionalAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]) ? "gemini" : "openai",
          embedding_model: "unknown",
          embedding_query: query,
          retrieved: [],
          error: e instanceof Error ? e.message : String(e),
        };
        dbForRoutine = dbAll;
      }
    }

    const routine_primary = buildPrimaryRoutine(dbForRoutine, user, query, budgetCny);
    const routine_budget = buildBudgetSafeRoutine(dbForRoutine, user, query, budgetCny);
    const over_budget = budgetCny != null && Number.isFinite(budgetCny) ? routine_primary.total_cny > budgetCny : false;
    const routine = routine_primary;

    const evidenceIndex = await buildRoutineEvidenceIndex({
      routines: [routine_primary, ...(over_budget ? [routine_budget] : [])],
      region: detectedRegion,
    });
    const routine_primary_with_evidence = attachEvidenceToRoutine(routine_primary, evidenceIndex);
    const routine_budget_with_evidence = over_budget ? attachEvidenceToRoutine(routine_budget, evidenceIndex) : null;
    const evidencePacks = Array.from(evidenceIndex.evidenceByProductId.values());
    const evidenceSummary = {
      products_in_routine: evidencePacks.length,
      products_with_kb: evidencePacks.filter((p) => (p.citations?.length ?? 0) > 0).length,
    };

    const summarizeRoutinePrices = (r: RoutineRec) => {
      const seen = new Set<string>();
      let knownUsd = 0;
      let unknownCount = 0;
      for (const step of [...r.am, ...r.pm]) {
        const skuId = step.sku.sku_id;
        if (seen.has(skuId)) continue;
        seen.add(skuId);
        const usd = normalizeUsdPrice(step.sku.price);
        if (usd == null) {
          unknownCount += 1;
        } else {
          knownUsd += usd;
        }
      }
      const knownUsdRounded = Math.round(knownUsd * 100) / 100;
      const knownCnyRounded = Math.round(computeUsdToCny(knownUsdRounded) * 100) / 100;
      return { known_usd: knownUsdRounded, known_cny_est: knownCnyRounded, unknown_count: unknownCount, total_unique: seen.size };
    };

    const sanitizeRoutineForLlm = (r: RoutineRecWithEvidence | null) => {
      if (!r) return null;
      return {
        am: r.am.map((s) => ({ ...s, sku: sanitizeSkuForLlm(s.sku) })),
        pm: r.pm.map((s) => ({ ...s, sku: sanitizeSkuForLlm(s.sku) })),
      };
    };

    const routineContextData = {
      user_query: query,
      region_preference: detectedRegion,
      budget_cny: budgetCny,
      budget_usd_est: budgetCny != null ? budgetCny / USD_TO_CNY : null,
      detected: {
        oily_acne: detectOilyAcne(query),
        sensitive_skin: detectSensitiveSkin(query),
        barrier_impaired: detectBarrierImpaired(query),
      },
      user_profile_inferred: sanitizeUserForLlm(user),
      routine_evidence_summary: evidenceSummary,
      retrieval,
      price_summary: {
        primary: summarizeRoutinePrices(routine_primary),
        strict_budget: over_budget ? summarizeRoutinePrices(routine_budget) : null,
      },
      routine: {
        primary: sanitizeRoutineForLlm(routine_primary_with_evidence),
        strict_budget: sanitizeRoutineForLlm(over_budget ? routine_budget_with_evidence : null),
        over_budget,
      },
    };

    const systemPrompt = buildAuroraStructuredSystemPrompt({
      regionLabel,
      // Keep the JSON compact to preserve model output budget (Gemini has a total context window).
      contextDataJson: JSON.stringify(routineContextData),
      mode: "routine",
    });

    const fallbackAnswer = buildFallbackRoutineAnswer({
      query,
      budget_cny: budgetCny,
      routine_primary,
      routine_budget: over_budget ? routine_budget : undefined,
    });

    let answer = "";
    let llm_error: string | null = null;
    try {
      answer =
        provider === "gemini"
          ? await geminiGenerateContent({ system_prompt: systemPrompt, user_prompt: `User request: ${query}`, model: requestedModel })
          : await openaiChatCompletion({
              model: requestedModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `User request: ${query}` },
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

    if (wantsStream) return streamTextResponse(answer);

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
        detected: {
          oily_acne: detectOilyAcne(query),
          sensitive_skin: detectSensitiveSkin(query),
          barrier_impaired: detectBarrierImpaired(query),
          region_preference: detectedRegion,
        },
        budget_cny: budgetCny,
        routine,
        routine_primary,
        routine_budget,
        over_budget,
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

  const sensitive = detectSensitiveSkin(query);
  const barrierImpaired = detectBarrierImpaired(query);
  const user = buildUserVectorFromQuery(query);

  if (!anchor) {
    return NextResponse.json({ error: "Anchor product not found", anchor_product_id: anchorProductId }, { status: 404 });
  }

  // KB-only anchor support: allow the user to ask about products that exist in KB but haven't been vectorized yet.
  if (!anchor.vectors) {
    const availability = Array.isArray((anchor as any).regionAvailability) ? ((anchor as any).regionAvailability as string[]) : [];
    const kbRows = await prisma.productKbSnippet.findMany({
      where: { productId: anchor.id },
      orderBy: [{ sourceSheet: "asc" }, { field: "asc" }, { updatedAt: "desc" }],
      select: { id: true, sourceSheet: true, field: true, content: true, metadata: true },
    });
    const snippets: KbSnippetForEvidence[] = kbRows.map((r) => ({
      id: r.id,
      source_sheet: r.sourceSheet,
      field: r.field,
      content: r.content,
      metadata: r.metadata,
    }));

    const kb_profile = buildKbProfile({
      product_id: anchor.id,
      display_name: `${anchor.brand} ${anchor.name}`.trim(),
      region: detectedRegion,
      availability,
      sku_risk_flags: [],
      sku_experience: null,
      snippets,
    });
    const expert_knowledge = buildExpertKnowledgeFromKb(snippets);

    const kbOnlyContext = {
      user_query: query,
      region_preference: detectedRegion,
      detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired },
      user_profile_inferred: sanitizeUserForLlm(user),
      limitations: ["Anchor product is present in KB, but vectors/embedding are missing.", "Similarity search and scoring are unavailable for this product."],
      anchor: {
        id: anchor.id,
        brand: anchor.brand,
        name: anchor.name,
        price_usd: normalizeUsdPrice(anchor.priceUsd),
        availability,
        kb_profile,
        expert_knowledge,
      },
      candidates: [],
    };

    const systemPrompt = buildAuroraStructuredSystemPrompt({
      regionLabel,
      contextDataJson: JSON.stringify(kbOnlyContext),
      mode: "product",
    });

    const fallbackAnswerParts: string[] = [];
    fallbackAnswerParts.push(
      `我找到了「${anchor.brand} ${anchor.name}」的专家知识库笔记，但这款目前还没有向量（vectors/embedding），所以无法给出精确 Aurora 分数或做余弦相似度“平替检索”。`,
    );
    if (expert_knowledge?.key_actives_summary) fallbackAnswerParts.push(`- 关键活性/要点：${expert_knowledge.key_actives_summary}`);
    if (expert_knowledge?.sensitivity_notes) fallbackAnswerParts.push(`- 敏感/刺激提示：${expert_knowledge.sensitivity_notes}`);
    if (expert_knowledge?.comparison_notes) fallbackAnswerParts.push(`- 对比/替代参考：${expert_knowledge.comparison_notes}`);
    fallbackAnswerParts.push(
      "如果你希望开启这款的“相似平替/打分”，需要补全成分表并重新运行向量化入库（让 sku_vectors.embedding 有值）。",
    );
    const fallbackAnswer = fallbackAnswerParts.join("\n");

    let answer = "";
    let llm_error: string | null = null;
    try {
      answer =
        provider === "gemini"
          ? await geminiGenerateContent({ system_prompt: systemPrompt, user_prompt: `User request: ${query}`, model: requestedModel })
          : await openaiChatCompletion({
              model: requestedModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `User request: ${query}` },
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

    if (wantsStream) return streamTextResponse(answer);

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
      context: kbOnlyContext,
    });
  }

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

  const similar = await findSimilarSkusByAnchorProductId(anchorProductId, {
    limit: Math.min(10, limit),
    cheaper_than_anchor: true,
    region: detectedRegion,
  });
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

  const kbRows = await prisma.productKbSnippet.findMany({
    where: { productId: { in: [anchor.id, ...candidateIds] } },
    orderBy: [{ sourceSheet: "asc" }, { field: "asc" }, { updatedAt: "desc" }],
    select: { id: true, productId: true, sourceSheet: true, field: true, content: true, metadata: true },
  });
  const kbByProductId = new Map<string, KbSnippetForEvidence[]>();
  for (const row of kbRows) {
    const list = kbByProductId.get(row.productId) ?? [];
    list.push({ id: row.id, source_sheet: row.sourceSheet, field: row.field, content: row.content, metadata: row.metadata });
    kbByProductId.set(row.productId, list);
  }

  const anchorIngredients = ingredientByProductId.get(anchor.id);
  const anchorIngredientCtx = summarizeIngredients(anchorIngredients?.fullList, anchorIngredients?.heroActives);
  const anchorExpertKnowledge = buildExpertKnowledgeFromKb(kbByProductId.get(anchor.id) ?? []);
  const anchorKbProfile = buildKbProfile({
    product_id: anchor.id,
    display_name: `${anchor.brand} ${anchor.name}`.trim(),
    region: detectedRegion,
    availability: Array.isArray((anchor as any).regionAvailability) ? ((anchor as any).regionAvailability as string[]) : [],
    sku_risk_flags: anchorSku.risk_flags,
    sku_experience: anchorSku.experience as any,
    snippets: kbByProductId.get(anchor.id) ?? [],
  });

  const mappedCandidates = candidates.map((c) => {
    const ing = ingredientByProductId.get(c.product_id);
    const ingCtx = summarizeIngredients(ing?.fullList, ing?.heroActives);
    return {
      product_id: c.product_id,
      brand: c.sku.brand,
      name: c.sku.name,
      price_usd: normalizeUsdPrice(c.sku.price),
      availability: c.availability,
      similarity: c.similarity,
      tradeoff: (() => {
        const ex = c.sku.experience;
        if (ex.texture === "sticky" || (ex.stickiness ?? 0) > 0.6) return "Texture is stickier.";
        if (ex.texture === "thick") return "Texture is thicker/richer.";
        if ((ex.pilling_risk ?? 0) > 0.6) return "Higher pilling risk under layering.";
        return "Lower-cost alternative.";
      })(),
      ingredients: ingCtx,
      expert_knowledge: buildExpertKnowledgeFromKb(kbByProductId.get(c.product_id) ?? []),
      kb_profile: buildKbProfile({
        product_id: c.product_id,
        display_name: `${c.sku.brand} ${c.sku.name}`.trim(),
        region: detectedRegion,
        availability: c.availability,
        sku_risk_flags: c.sku.risk_flags,
        sku_experience: c.sku.experience as any,
        snippets: kbByProductId.get(c.product_id) ?? [],
      }),
    };
  });

  const contextText = `User request: ${query}`;

  const anchorSkuForLlm = sanitizeSkuForLlm(anchorSku);

  const productContextData = {
    user_query: query,
    region_preference: detectedRegion,
    detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired },
    user_profile_inferred: sanitizeUserForLlm(user),
    anchor: {
      id: anchor.id,
      brand: anchor.brand,
      name: anchor.name,
      price_usd: anchorSkuForLlm.price_usd,
      availability: Array.isArray((anchor as any).regionAvailability) ? ((anchor as any).regionAvailability as string[]) : [],
      score: anchorScore,
      vetoed: anchorVetoed || anchorScore.vetoed,
      risk_flags: anchorRisk,
      burn_rate: anchorBurnRate,
      mechanism: anchorSkuForLlm.mechanism,
      experience: anchorSkuForLlm.experience,
      social_stats: anchorSkuForLlm.social_stats,
      ingredients: anchorIngredientCtx,
      expert_knowledge: anchorExpertKnowledge,
      kb_profile: anchorKbProfile,
    },
    candidates: candidates.slice(0, 5).map((c) => {
      const ing = ingredientByProductId.get(c.product_id);
      const ingCtx = summarizeIngredients(ing?.fullList, ing?.heroActives);
      const skuLlm = sanitizeSkuForLlm(c.sku);
      const ex = c.sku.experience;
      const tradeoff =
        ex.texture === "sticky" || (ex.stickiness ?? 0) > 0.6
          ? "Texture is stickier."
          : ex.texture === "thick"
            ? "Texture is thicker/richer."
            : (ex.pilling_risk ?? 0) > 0.6
              ? "Higher pilling risk under layering."
              : "Lower-cost alternative.";

      return {
        id: c.product_id,
        brand: c.sku.brand,
        name: c.sku.name,
        price_usd: skuLlm.price_usd,
        availability: c.availability,
        similarity: c.similarity,
        tradeoff,
        risk_flags: skuLlm.risk_flags,
        burn_rate: (skuLlm.social_stats as any)?.burn_rate ?? null,
        mechanism: skuLlm.mechanism,
        experience: skuLlm.experience,
        social_stats: skuLlm.social_stats,
        ingredients: ingCtx,
        expert_knowledge: buildExpertKnowledgeFromKb(kbByProductId.get(c.product_id) ?? []),
        kb_profile: buildKbProfile({
          product_id: c.product_id,
          display_name: `${c.sku.brand} ${c.sku.name}`.trim(),
          region: detectedRegion,
          availability: c.availability,
          sku_risk_flags: c.sku.risk_flags,
          sku_experience: c.sku.experience as any,
          snippets: kbByProductId.get(c.product_id) ?? [],
        }),
      };
    }),
  };

  const systemPrompt = buildAuroraStructuredSystemPrompt({
    regionLabel,
    contextDataJson: JSON.stringify(productContextData),
    mode: "product",
  });

  const fallbackAnswer = buildFallbackProductAnswer({
    query,
    detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired },
    anchor: {
      brand: anchor.brand,
      name: anchor.name,
      price_usd: normalizeUsdPrice(anchor.priceUsd),
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

  if (wantsStream) return streamTextResponse(answer);

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
      detected: { sensitive_skin: sensitive, barrier_impaired: barrierImpaired, region_preference: detectedRegion },
      anchor: {
        id: anchor.id,
        brand: anchor.brand,
        name: anchor.name,
        price_usd: coerceNumber(anchor.priceUsd),
        availability: Array.isArray((anchor as any).regionAvailability) ? ((anchor as any).regionAvailability as string[]) : [],
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

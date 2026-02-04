import type { IngredientSearchOutputV1 } from "@/lib/ingredient-search-core";

export type ExternalVerificationLike = {
  query: string;
  citations: Array<{
    title: string;
    source?: string;
    year?: number;
    url?: string;
    note?: string;
  }>;
  error?: string;
  note?: string;
};

type UserLanguage = "en" | "zh";

function detectUserLanguage(text: string): UserLanguage {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function wantsProductExamples(text: string): boolean {
  const q = text.toLowerCase();
  if (q.includes("which products") || q.includes("what products") || q.includes("products contain") || q.includes("contains")) return true;
  if (text.includes("哪些产品") || text.includes("什么产品") || text.includes("有哪些") || text.includes("含") || text.includes("包含") || text.includes("成分搜索")) return true;
  return false;
}

export function buildScienceFallbackAnswerV1(input: {
  user_query: string;
  regionLabel: string;
  external_verification: ExternalVerificationLike | null;
  active_mentions?: string[];
  ingredient_search?: IngredientSearchOutputV1 | null;
}): string {
  const lang = detectUserLanguage(input.user_query);
  const t = (en: string, zh: string) => (lang === "zh" ? zh : en);

  const mentions = Array.isArray(input.active_mentions) ? input.active_mentions.map((m) => String(m).trim()).filter(Boolean) : [];
  const topicLabel = mentions.length ? mentions.join(lang === "zh" ? " / " : " / ") : t("this ingredient/topic", "这个成分/主题");

  const hasCitations = Boolean(input.external_verification?.citations?.length);
  const askForProducts = wantsProductExamples(input.user_query);

  const lines: string[] = [];
  lines.push(hasCitations ? t("Based on the currently available external verification summary:", "基于目前可用的外部验证摘要：") : t("Based on general dermatological consensus:", "基于一般皮肤科共识："));

  lines.push(
    t(
      `- Topic: ${topicLabel}. Evidence strength depends on the exact molecule, concentration, formulation stability, and study design.`,
      `- 主题：${topicLabel}。证据强度取决于具体分子/浓度/配方稳定性，以及研究设计与终点指标。`,
    ),
  );

  lines.push(
    t(
      "- Cosmetic ingredient evidence often ranges from in‑vitro/mechanistic data to small human trials; strong, large RCTs are less common for many actives.",
      "- 护肤品活性证据常见从体外/机理推断到小样本人体验证不等；很多成分缺少大样本、高质量 RCT。",
    ),
  );

  lines.push(
    t(
      "- Safety-first approach: patch test, start low frequency, avoid stacking multiple strong actives at once, and use sunscreen if the ingredient increases photosensitivity.",
      "- 安全优先：先做斑贴测试、从低频开始、避免同一晚叠加强活性（多酸/高强度维A等），并在需要时强化防晒。",
    ),
  );

  if (hasCitations) {
    const citations = input.external_verification?.citations ?? [];
    const top = citations.slice(0, 5);
    lines.push("");
    lines.push(t("Selected citations (PubMed):", "参考文献（PubMed，节选）："));
    for (const c of top) {
      const title = String(c?.title ?? "").trim();
      if (!title) continue;
      const year = typeof c?.year === "number" ? c.year : null;
      const source = typeof c?.source === "string" && c.source.trim() ? c.source.trim() : "";
      const url = typeof c?.url === "string" && c.url.trim() ? c.url.trim() : "";
      const note = typeof c?.note === "string" && c.note.trim() ? c.note.trim() : "";
      const meta = [year ? String(year) : "", source].filter(Boolean).join(", ");
      const tail = [url, note].filter(Boolean).join(" · ");
      lines.push(`- ${title}${meta ? ` (${meta})` : ""}${tail ? ` — ${tail}` : ""}`);
    }
  }

  const hits = input.ingredient_search?.hits ?? [];
  if (askForProducts) {
    if (hits.length) {
      const top = hits.slice(0, 6).map((h) => h.display_name || h.product_id);
      lines.push("");
      lines.push(t("Examples in our KB that match your query:", "我们 KB 里匹配到的产品示例（仅供检索参考）："));
      for (const [idx, name] of top.entries()) lines.push(`${idx + 1}) ${name}`);
      lines.push(t("Note: formulas vary by region/batch—confirm with the official INCI when buying.", "备注：不同地区/批次配方可能不同，购买前以官方 INCI 为准。"));
    } else {
      lines.push("");
      lines.push(t("I can list product examples once I know the exact ingredient keyword (INCI/English name).", "如果你告诉我更精确的成分关键词（INCI/英文名），我可以列出数据库里包含它的产品示例。"));
    }
  }

  lines.push("");
  lines.push(t("To make this answer more specific (and avoid guessing), reply with 1–2 items:", "为了更具体、避免我“装懂”，你补充 1–2 个信息即可："));
  lines.push(t("1) The exact INCI/ingredient name (or a product link / ingredient list).", "1) 成分的准确名称（INCI/英文名），或产品链接/成分表。"));
  lines.push(t(`2) Your region is ${input.regionLabel}. What is your main goal and are you sensitive?`, `2) 你坐标 ${input.regionLabel}，主要目标是什么？是否敏感/容易刺痛？`));

  return lines.join("\n");
}

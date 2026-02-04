export type KbCanonicalKey = "sensitivity" | "key_actives" | "comparison" | "usage" | "texture" | "notes" | "unknown";

export type KbSnippetLike = {
  field: string;
  metadata?: unknown;
};

export function inferKbCanonicalKeyFromSnippet(snippet: KbSnippetLike): KbCanonicalKey {
  const meta = (snippet.metadata ?? null) as any;
  const metaKey =
    typeof meta?.canonical_key === "string"
      ? meta.canonical_key
      : typeof meta?.canonicalKey === "string"
        ? meta.canonicalKey
        : typeof meta?.canonical_field === "string"
          ? meta.canonical_field
          : null;

  const label = [metaKey, meta?.field_label, snippet.field]
    .filter((v) => typeof v === "string" && v.trim())
    .join(" ")
    .toLowerCase();

  // Sensitivity / irritation
  if (
    label.includes("sensitivity") ||
    label.includes("irrit") ||
    label.includes("risk") ||
    label.includes("敏感") ||
    label.includes("刺激") ||
    label.includes("刺痛") ||
    label.includes("过敏")
  ) {
    return "sensitivity";
  }

  // Key actives
  if (
    label.includes("key_actives") ||
    (label.includes("key") && (label.includes("active") || label.includes("actives"))) ||
    label.includes("主要成分") ||
    label.includes("核心成分") ||
    label.includes("关键活性") ||
    label.includes("功效成分")
  ) {
    return "key_actives";
  }

  // Comparison / dupes
  if (
    label.includes("comparison") ||
    label.includes("compare") ||
    label.includes("dupe") ||
    label.includes("替代") ||
    label.includes("平替") ||
    label.includes("对比") ||
    label.includes("竞品")
  ) {
    return "comparison";
  }

  // Usage / pairing
  if (
    label.includes("usage") ||
    label.includes("routine") ||
    label.includes("layer") ||
    label.includes("frequency") ||
    label.includes("warning") ||
    label.includes("caution") ||
    label.includes("用法") ||
    label.includes("搭配") ||
    label.includes("叠加") ||
    label.includes("频率") ||
    label.includes("注意事项") ||
    label.includes("警示") ||
    label.includes("警告")
  ) {
    return "usage";
  }

  // Texture / finish
  if (
    label.includes("texture") ||
    label.includes("finish") ||
    label.includes("pilling") ||
    label.includes("质地") ||
    label.includes("清爽") ||
    label.includes("厚重") ||
    label.includes("搓泥") ||
    label.includes("成膜") ||
    label.includes("油腻")
  ) {
    return "texture";
  }

  if (label.includes("notes") || label.includes("note") || label.includes("备注") || label.includes("评价")) return "notes";
  if (!label.trim()) return "unknown";
  return "notes";
}


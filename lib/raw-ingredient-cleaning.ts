const MARKETING_TAG_RE = /(^|\s)#[^\s,;，；、]+/g;
const URL_RE = /\bhttps?:\/\/[^\s,;，；、]+/gi;
const LEADING_LABEL_RE = /^\s*(ingredients?|inci|full\s*ingredients?|全成分|成分|配料)\s*[:：\-]\s*/i;
const NOISE_FRAGMENT_PATTERNS: RegExp[] = [
  /\[(?:more|read\s*more|show\s*more|view\s*full\s*list)\]/gi,
  /\bread\s+more\b/gi,
  /\bshow\s+more\b/gi,
  /\bview\s+full\s+list\b/gi,
  /\bclick\s+here\b/gi,
  /\bsee\s+text\b/gi,
  /\bsee\s+image\b/gi,
];

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTokenForDedup(token: string): string {
  return normalizeSpaces(token)
    .toLowerCase()
    .replace(/^[,;，；、\.\s]+|[,;，；、\.\s]+$/g, "");
}

function splitIngredientLikeTokens(value: string): string[] {
  const rawTokens = value.split(/[,\n\r;；，、]+/g);
  const out: string[] = [];
  for (const raw of rawTokens) {
    const token = normalizeSpaces(raw).replace(/^[,;，；、\.\s]+|[,;，；、\.\s]+$/g, "");
    if (!token) continue;
    out.push(token);
  }
  return out;
}

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const key = normalizeTokenForDedup(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function computeDuplicateWordRatio(value: string): number {
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  if (words.length < 4) return 0;
  const unique = new Set(words).size;
  return (words.length - unique) / words.length;
}

function cleanNoise(value: string): string {
  let out = value.normalize("NFKC");
  out = out.replace(URL_RE, " ");
  out = out.replace(MARKETING_TAG_RE, " ");
  for (const pattern of NOISE_FRAGMENT_PATTERNS) out = out.replace(pattern, " ");
  out = out.replace(/\.\.\./g, " ");
  out = normalizeSpaces(out);

  while (LEADING_LABEL_RE.test(out)) out = out.replace(LEADING_LABEL_RE, "");
  out = out.replace(/\s+(?:and|&)\s*(?:\.\.\.)?\s*$/i, "");
  out = out.replace(/\s*etc\.?\s*$/i, "");
  out = normalizeSpaces(out).replace(/^[,;，；、\.\s]+|[,;，；、\.\s]+$/g, "");
  return out;
}

function normalizeFullList(fullList: unknown): string[] {
  if (!Array.isArray(fullList)) return [];
  return dedupeTokens(
    fullList
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  );
}

function shouldPreferFullList(cleaned: string, fullList: string[]): boolean {
  if (fullList.length < 3) return false;
  const fullListJoined = fullList.join(", ");
  const duplicateWordRatio = computeDuplicateWordRatio(cleaned);
  const tokens = splitIngredientLikeTokens(cleaned);
  const uniqueTokenRatio = tokens.length ? new Set(tokens.map(normalizeTokenForDedup)).size / tokens.length : 1;
  const cleanedNorm = normalizeTokenForDedup(cleaned);
  const hits = fullList.filter((item) => cleanedNorm.includes(normalizeTokenForDedup(item))).length;
  const coverage = hits / fullList.length;

  return (
    (cleaned.length > fullListJoined.length * 1.6 && coverage >= 0.4) ||
    (duplicateWordRatio >= 0.28 && coverage >= 0.35) ||
    (uniqueTokenRatio <= 0.65 && coverage >= 0.35)
  );
}

export function cleanRawIngredientText(value: string): string {
  const cleaned = cleanNoise(value);
  if (!cleaned) return "";
  const tokens = splitIngredientLikeTokens(cleaned);
  if (tokens.length <= 1) return cleaned;
  return dedupeTokens(tokens).join(", ");
}

export function canonicalizeRawIngredientText(value: string | null | undefined, fullList?: unknown): string | null {
  const source = String(value ?? "").trim();
  if (!source) return null;

  const cleaned = cleanRawIngredientText(source);
  if (!cleaned) return null;

  const normalizedFullList = normalizeFullList(fullList);
  if (shouldPreferFullList(cleaned, normalizedFullList)) return normalizedFullList.join(", ");
  return cleaned;
}

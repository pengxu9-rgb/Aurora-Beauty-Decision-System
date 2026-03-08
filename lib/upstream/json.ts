function stripCodeFence(input: string) {
  const text = String(input || "").trim();
  if (!text.startsWith("```")) return text;
  return text.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pickFirstTrimmed(...values: unknown[]) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

export function parseJsonOnlyObject(text: string) {
  const normalized = stripCodeFence(text);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(normalized);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractBraced(text: string, startIdx: number) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx: number | null = null;

  for (let index = startIdx; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endIdx = index;
        break;
      }
    }
  }

  if (endIdx == null || depth !== 0) return null;
  return text.slice(startIdx, endIdx + 1);
}

export function extractJsonObject(text: string) {
  const normalized = stripCodeFence(text);
  if (!normalized) return null;
  for (let start = normalized.indexOf("{"); start !== -1; start = normalized.indexOf("{", start + 1)) {
    const candidate = extractBraced(normalized, start);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // continue
    }
  }
  return null;
}

export function extractJsonObjectByKeys(text: string, requiredKeys: string[]) {
  const keys = Array.isArray(requiredKeys)
    ? requiredKeys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];
  if (!keys.length) return extractJsonObject(text);
  const normalized = stripCodeFence(text);
  if (!normalized) return null;

  let best: Record<string, unknown> | null = null;
  let bestScore = 0;
  let bestSize = 0;

  for (let start = normalized.indexOf("{"); start !== -1; start = normalized.indexOf("{", start + 1)) {
    const candidate = extractBraced(normalized, start);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (!isPlainObject(parsed)) continue;
      const score = keys.reduce((count, key) => (Object.prototype.hasOwnProperty.call(parsed, key) ? count + 1 : count), 0);
      if (score === 0) continue;
      const size = Object.keys(parsed).length;
      if (score > bestScore || (score === bestScore && size >= bestSize)) {
        best = parsed;
        bestScore = score;
        bestSize = size;
        if (bestScore === keys.length) return best;
      }
    } catch {
      // continue
    }
  }

  return best;
}

import type { ModelExecutionResult, SupportedProvider } from "./types.ts";

function optionalAnyEnv(names: string[]) {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
}

function requireAnyEnv(names: string[]) {
  const value = optionalAnyEnv(names);
  if (!value) throw new Error(`Missing required env var (one of): ${names.join(", ")}`);
  return value;
}

function normalizeGeminiModelName(model: string) {
  const trimmed = String(model || "").trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

function resolveProvider(preferred: SupportedProvider | null): SupportedProvider {
  if (preferred) return preferred;
  if (optionalAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"])) return "gemini";
  return "openai";
}

function resolveModel(provider: SupportedProvider, requested: string | null) {
  if (requested) return provider === "gemini" ? normalizeGeminiModelName(requested) : requested.trim();
  if (provider === "gemini") {
    return normalizeGeminiModelName(
      process.env.AURORA_UPSTREAM_GEMINI_MODEL ||
        process.env.GEMINI_LLM_MODEL ||
        process.env.GEMINI_MODEL ||
        "gemini-2.5-flash",
    );
  }
  return (
    process.env.AURORA_UPSTREAM_OPENAI_MODEL ||
    process.env.OPENAI_LLM_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini"
  ).trim();
}

async function geminiGenerateText(prompt: string, model: string) {
  const apiKey = requireAnyEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1").trim().replace(/\/$/, "");
  const url = `${apiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini generateContent failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as any;
  const parts = payload?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim()
    : "";
  if (!text) throw new Error("Gemini response missing text");
  return text;
}

async function openaiGenerateText(prompt: string, model: string) {
  const apiKey = requireAnyEnv(["OPENAI_API_KEY"]);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI chat.completions failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as any;
  const content = payload?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new Error("OpenAI response missing text");
  return text;
}

export async function executePromptText({
  prompt,
  preferredProvider,
  requestedModel,
}: {
  prompt: string;
  preferredProvider: SupportedProvider | null;
  requestedModel: string | null;
}): Promise<ModelExecutionResult> {
  const provider = resolveProvider(preferredProvider);
  const model = resolveModel(provider, requestedModel);
  const text =
    provider === "gemini" ? await geminiGenerateText(prompt, model) : await openaiGenerateText(prompt, model);
  return { provider, model, text };
}

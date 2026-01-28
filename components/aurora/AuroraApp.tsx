"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calculator,
  Cuboid,
  GitCompareArrows,
  Layers,
  MessageSquareText,
  Moon,
  Sun,
  Terminal,
  Wallet,
} from "lucide-react";

import { AURORA_SKU_DB, DEFAULT_ANCHOR_SKU_ID, DEFAULT_USER_VECTOR } from "@/data/mock-db";
import { calculateScore, findDupes } from "@/lib/engine";
import { formatCurrency, humanizeCategory, runAurora } from "@/lib/aurora/engine";
import type { MechanismKey, Platform, SkuVector, UserVector } from "@/lib/aurora/types";

type ViewId = "input" | "output" | "vectors" | "scoring" | "dupes" | "routine" | "budget";
type UserPresetId = "custom" | "oily_acne" | "sensitive_redness";

type AnalyzeResponse = {
  anchor_score: {
    science: number;
    social: number;
    engineering: number;
    total: number;
    vetoed: boolean;
    veto_reason?: string;
  };
  dupes: Array<{
    sku: SkuVector;
    similarity: number;
    tradeoff_note: string;
  }>;
  recommended_dupe: { sku: SkuVector; similarity: number; tradeoff_note: string } | null;
};

const MECHANISM_OPTIONS: Array<{ key: MechanismKey; label: string }> = [
  { key: "oil_control", label: "Oil Control" },
  { key: "redness", label: "Redness" },
  { key: "brightening", label: "Brightening" },
  { key: "acne_comedonal", label: "Acne (Comedonal)" },
  { key: "repair", label: "Repair" },
  { key: "soothing", label: "Soothing" },
];

const PLATFORM_OPTIONS: Platform[] = ["RED", "Ecommerce", "Reddit", "DermSources"];

function getInitials(brand: string) {
  const parts = brand.split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "A").toUpperCase();
}

function formatPercent(value: number) {
  const v = Math.round(value * 100);
  return `${v}%`;
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function VectorBar({
  label,
  value,
  colorClass,
  monoClass,
}: {
  label: string;
  value: number;
  colorClass: string;
  monoClass?: string;
}) {
  const pct = clampNumber(value, 0, 1) * 100;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span>{label}</span>
        <span className={["font-mono", monoClass ?? "text-indigo-600"].join(" ")}>{value.toFixed(2)}</span>
      </div>
      <div className="w-full bg-slate-100 rounded-full h-1.5">
        <div className={[colorClass, "h-1.5 rounded-full"].join(" ")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CodeBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="bg-slate-900 rounded-xl overflow-hidden shadow-lg flex flex-col">
      <div className="bg-slate-800 px-4 py-2 text-xs text-slate-300 border-b border-slate-700 font-mono">
        {title}
      </div>
      <pre className="p-4 overflow-auto terminal-scroll text-[11px] leading-relaxed text-slate-200 font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function SidebarNav({
  activeView,
  onChange,
}: {
  activeView: ViewId;
  onChange: (view: ViewId) => void;
}) {
  const btnBase =
    "nav-btn w-full text-left px-3 py-3 rounded-lg hover:bg-slate-800 hover:text-white transition-colors flex items-center gap-3 border-l-2";

  const btn = (view: ViewId, label: string, icon: ReactNode) => {
    const active = view === activeView;
    return (
      <button
        type="button"
        onClick={() => onChange(view)}
        className={[
          btnBase,
          active ? "bg-slate-800 text-white border-indigo-500" : "border-transparent text-slate-400",
        ].join(" ")}
      >
        <span className="w-4 h-4 text-slate-300">{icon}</span>
        <span>{label}</span>
      </button>
    );
  };

  return (
    <aside className="w-64 bg-slate-900 text-slate-400 flex flex-col shrink-0 shadow-2xl z-50">
      <div className="p-6 border-b border-slate-800 bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-indigo-600 rounded-lg flex items-center justify-center text-white font-bold shadow-lg">
            A
          </div>
          <div>
            <h1 className="font-bold text-white tracking-tight text-base">Aurora v4.0</h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Logic Core</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-6 space-y-1 px-3">
        <div className="text-[10px] font-bold text-slate-600 uppercase px-3 mb-2 mt-2">I/O 层</div>
        {btn("input", "1. 输入解析 & 画像", <Terminal className="w-4 h-4" />)}
        {btn("output", "2. 最终输出预览", <MessageSquareText className="w-4 h-4" />)}

        <div className="text-[10px] font-bold text-slate-600 uppercase px-3 mb-2 mt-6">核心引擎</div>
        {btn("vectors", "3. SKU 向量化", <Cuboid className="w-4 h-4" />)}
        {btn("scoring", "4. 评分与裁决", <Calculator className="w-4 h-4" />)}
        {btn("dupes", "5. Dupe / Compare", <GitCompareArrows className="w-4 h-4" />)}

        <div className="text-[10px] font-bold text-slate-600 uppercase px-3 mb-2 mt-6">策略层</div>
        {btn("routine", "6. 搭配与禁忌", <Layers className="w-4 h-4" />)}
        {btn("budget", "7. High-Low 预算", <Wallet className="w-4 h-4" />)}
      </nav>

      <div className="p-4 bg-slate-800 text-[10px] text-center text-slate-500">
        Status: <span className="text-emerald-400">R&amp;D Ready</span>
      </div>
    </aside>
  );
}

function Header({ subtitle }: { subtitle: string }) {
  return (
    <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0 z-40">
      <div className="flex items-center gap-2">
        <span className="px-2 py-1 bg-indigo-50 text-indigo-700 rounded text-xs font-bold border border-indigo-100">
          Case Study
        </span>
        <span className="text-xs text-slate-500">{subtitle}</span>
      </div>
      <div className="flex gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Science
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          Social
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-slate-500" />
          Eng
        </div>
      </div>
    </header>
  );
}

function SummaryPill({ text, tone }: { text: string; tone: "red" | "amber" | "emerald" | "blue" | "slate" }) {
  const map: Record<typeof tone, string> = {
    red: "bg-red-50 text-red-600 border-red-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    blue: "bg-blue-50 text-blue-600 border-blue-100",
    slate: "bg-slate-50 text-slate-600 border-slate-100",
  };
  return <span className={["px-2 py-1 rounded border text-xs", map[tone]].join(" ")}>{text}</span>;
}

function formatSkinType(skinType: UserVector["skin_type"]) {
  if (Array.isArray(skinType)) return skinType.join(" / ");
  return skinType;
}

function pickSku(db: SkuVector[], skuId: string) {
  return db.find((s) => s.sku_id === skuId) ?? db[0] ?? null;
}

function safeNumberInput(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function AuroraApp() {
  const [activeView, setActiveView] = useState<ViewId>("input");
  const [presetId, setPresetId] = useState<UserPresetId>("custom");
  const [user, setUser] = useState<UserVector>(() => structuredClone(DEFAULT_USER_VECTOR));
  const [anchorSkuId, setAnchorSkuId] = useState<string>(DEFAULT_ANCHOR_SKU_ID);
  const [selectedDupeId, setSelectedDupeId] = useState<string>("");
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [skuDb, setSkuDb] = useState<SkuVector[]>(() => AURORA_SKU_DB);
  const [skuDbStatus, setSkuDbStatus] = useState<"mock" | "loading" | "db">("mock");
  const [skuDbError, setSkuDbError] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState<string>("");
  const [chatAnswer, setChatAnswer] = useState<string>("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [isChatting, setIsChatting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSkuDatabase() {
      setSkuDbStatus("loading");
      setSkuDbError(null);

      try {
        const base = (process.env.NEXT_PUBLIC_AURORA_SERVICE_URL ?? "").replace(/\/$/, "");
        const url = `${base}/v1/decision/skus`;
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Failed to load SKUs (${res.status})`);
        }

        const json = (await res.json()) as { skus?: SkuVector[] };
        const skus = Array.isArray(json.skus) ? json.skus : [];

        if (!cancelled && skus.length > 0) {
          setSkuDb(skus);
          setSkuDbStatus("db");
          // Keep the currently-selected anchor if it still exists; otherwise fall back to the first DB SKU.
          setAnchorSkuId((current) =>
            skus.some((s) => s.sku_id === current) ? current : (skus[0]?.sku_id ?? DEFAULT_ANCHOR_SKU_ID),
          );
        } else if (!cancelled) {
          setSkuDbStatus("mock");
        }
      } catch (err) {
        if (!cancelled) {
          setSkuDbStatus("mock");
          setSkuDbError(err instanceof Error ? err.message : "Failed to load SKUs");
        }
      }
    }

    void loadSkuDatabase();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useMemo(() => runAurora(user, skuDb, anchorSkuId), [user, skuDb, anchorSkuId]);
  const anchor = run.anchor;

  const localAnchorScore = useMemo(() => calculateScore(anchor, user), [anchor, user]);
  const anchorScore = analysis?.anchor_score ?? localAnchorScore;

  const dupeDatabase = useMemo(() => {
    // If the anchor is a serum/treatment, keep dupes in the same “active” lane.
    if (anchor.category === "serum" || anchor.category === "treatment") {
      return skuDb.filter((s) => s.category === "serum" || s.category === "treatment");
    }
    return skuDb;
  }, [anchor.category, skuDb]);

  const localDupes = useMemo(() => findDupes(anchor, dupeDatabase, 6), [anchor, dupeDatabase]);
  const dupes = analysis?.dupes ?? localDupes;
  const localRecommendedDupe = useMemo(
    () => localDupes.find((d) => d.sku.brand === "The Ordinary") ?? localDupes[0] ?? null,
    [localDupes],
  );
  const recommendedDupe = analysis?.recommended_dupe ?? localRecommendedDupe;

  const selectedDupe = pickSku(
    skuDb,
    selectedDupeId || recommendedDupe?.sku.sku_id || dupes[0]?.sku.sku_id || skuDb[0]?.sku_id || "",
  );

  const subtitle = `${formatSkinType(user.skin_type)} / barrier:${user.barrier_status} / budget:${user.budget.total_monthly}`;

  const applyPreset = useCallback(
    (next: UserPresetId) => {
      setPresetId(next);

      if (next === "custom") return;

      setAnchorSkuId(DEFAULT_ANCHOR_SKU_ID);

      if (next === "oily_acne") {
        setUser((u) => ({
          ...u,
          skin_type: "oily",
          barrier_status: "healthy",
          goals: [
            { track: "oil_control", priority: 1 },
            { track: "acne_comedonal", priority: 1 },
            { track: "redness", priority: 2 },
            { track: "brightening", priority: 3 },
          ],
        }));
        return;
      }

      // sensitive_redness
      setUser((u) => ({
        ...u,
        skin_type: "sensitive",
        barrier_status: "impaired",
        goals: [
          { track: "soothing", priority: 1 },
          { track: "redness", priority: 1 },
          { track: "repair", priority: 2 },
        ],
      }));
    },
    [setUser],
  );

  const handleAnalyze = useCallback(async () => {
    setIsAnalyzing(true);
    setAnalysisError(null);
    setActiveView("scoring");

    try {
      const base = (process.env.NEXT_PUBLIC_AURORA_SERVICE_URL ?? "").replace(/\/$/, "");
      const url = `${base}/v1/decision/analyze`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anchor_sku_id: anchorSkuId,
          user,
          dupe_limit: 6,
          prefer_brand: "The Ordinary",
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Analyze failed (${res.status})`);
      }

      const json = (await res.json()) as AnalyzeResponse;
      setAnalysis(json);
      if (json.recommended_dupe) setSelectedDupeId(json.recommended_dupe.sku.sku_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analyze failed";
      setAnalysisError(message);
      // Fallback to local engine so the UI still works offline.
      if (localRecommendedDupe) setSelectedDupeId(localRecommendedDupe.sku.sku_id);
    } finally {
      setIsAnalyzing(false);
    }
  }, [anchorSkuId, localRecommendedDupe, user]);

  const handleChat = useCallback(async () => {
    const q = chatQuery.trim();
    if (!q) return;

    setIsChatting(true);
    setChatError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Chat failed (${res.status})`);
      }

      const json = (await res.json()) as { answer?: string };
      setChatAnswer(typeof json.answer === "string" ? json.answer : "");
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Chat failed");
      setChatAnswer("");
    } finally {
      setIsChatting(false);
    }
  }, [chatQuery]);

  const inputSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-800">1. 输入解析与画像向量</h2>
          <p className="text-slate-500 mt-2">将用户信号转化为结构化向量，驱动后续的权重计算。</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {skuDbStatus === "db" ? (
              <SummaryPill text={`DB Connected (${skuDb.length} SKUs)`} tone="emerald" />
            ) : skuDbStatus === "loading" ? (
              <SummaryPill text="Loading SKUs..." tone="amber" />
            ) : (
              <SummaryPill text="Using Mock SKUs" tone="slate" />
            )}
            {skuDbError ? <SummaryPill text={`SKU Load Error: ${skuDbError}`} tone="amber" /> : null}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center">
                  <Terminal className="w-4 h-4" />
                </div>
                <h3 className="font-bold text-slate-800">User Profile (Manual Console)</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <label className="space-y-1 sm:col-span-2">
                  <div className="text-xs font-semibold text-slate-600">Preset</div>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={presetId}
                    onChange={(e) => applyPreset(e.target.value as UserPresetId)}
                  >
                    <option value="custom">自定义 / Custom</option>
                    <option value="oily_acne">油痘肌</option>
                    <option value="sensitive_redness">泛红敏感肌</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <div className="text-xs font-semibold text-slate-600">Skin Type</div>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={Array.isArray(user.skin_type) ? user.skin_type[0] : user.skin_type}
                    onChange={(e) =>
                      setUser((u) => ({ ...u, skin_type: (e.target.value || "combination") as UserVector["skin_type"] }))
                    }
                  >
                    <option value="oily">oily</option>
                    <option value="dry">dry</option>
                    <option value="combination">combination</option>
                    <option value="normal">normal</option>
                    <option value="sensitive">sensitive</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <div className="text-xs font-semibold text-slate-600">Barrier Status</div>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={user.barrier_status}
                    onChange={(e) => setUser((u) => ({ ...u, barrier_status: e.target.value as UserVector["barrier_status"] }))}
                  >
                    <option value="healthy">healthy</option>
                    <option value="impaired">impaired</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <div className="text-xs font-semibold text-slate-600">Monthly Budget</div>
                  <input
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    type="number"
                    value={user.budget.total_monthly}
                    onChange={(e) =>
                      setUser((u) => ({ ...u, budget: { ...u.budget, total_monthly: safeNumberInput(e.target.value) } }))
                    }
                  />
                </label>

                <label className="space-y-1">
                  <div className="text-xs font-semibold text-slate-600">Anchor SKU</div>
                  <select
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={anchorSkuId}
                    onChange={(e) => setAnchorSkuId(e.target.value)}
                  >
                    {skuDb.map((s) => (
                      <option key={s.sku_id} value={s.sku_id}>
                        {s.brand} — {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-6">
                <h4 className="text-xs font-bold text-slate-500 uppercase mb-3">Goals (track + priority)</h4>
                <div className="space-y-3">
                  {user.goals.map((g, idx) => (
                    <div key={`${g.track}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                      <select
                        className="col-span-8 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                        value={g.track}
                        onChange={(e) =>
                          setUser((u) => ({
                            ...u,
                            goals: u.goals.map((x, i) => (i === idx ? { ...x, track: e.target.value as MechanismKey } : x)),
                          }))
                        }
                      >
                        {MECHANISM_OPTIONS.map((opt) => (
                          <option key={opt.key} value={opt.key}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className="col-span-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                        type="number"
                        min={1}
                        max={5}
                        value={g.priority}
                        onChange={(e) =>
                          setUser((u) => ({
                            ...u,
                            goals: u.goals.map((x, i) => (i === idx ? { ...x, priority: safeNumberInput(e.target.value) } : x)),
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="col-span-1 text-slate-400 hover:text-rose-600 text-sm"
                        onClick={() => setUser((u) => ({ ...u, goals: u.goals.filter((_, i) => i !== idx) }))}
                        aria-label="Remove goal"
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}

                  <button
                    type="button"
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                    onClick={() =>
                      setUser((u) => ({
                        ...u,
                        goals: [...u.goals, { track: "soothing", priority: 3 }],
                      }))
                    }
                    disabled={user.goals.length >= 6}
                  >
                    + Add goal
                  </button>
                </div>
              </div>

              <div className="mt-6">
                <h4 className="text-xs font-bold text-slate-500 uppercase mb-3">Platform Weights (auto-normalized)</h4>
                <div className="grid grid-cols-2 gap-3">
                  {PLATFORM_OPTIONS.map((p) => (
                    <label key={p} className="space-y-1">
                      <div className="text-xs font-semibold text-slate-600">{p}</div>
                      <input
                        className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-mono"
                        type="number"
                        step={0.05}
                        min={0}
                        max={1}
                        value={user.platform_weights[p] ?? 0}
                        onChange={(e) =>
                          setUser((u) => ({
                            ...u,
                            platform_weights: { ...u.platform_weights, [p]: safeNumberInput(e.target.value) },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={handleAnalyze}
                className="mt-6 w-full rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold shadow-sm hover:bg-indigo-700 transition-colors disabled:opacity-60"
                disabled={isAnalyzing}
              >
                {isAnalyzing ? "分析中..." : "分析 / Analyze"}
              </button>
              {analysisError ? (
                <div className="mt-3 text-xs text-rose-600">
                  Backend analyze failed; showing local results. ({analysisError})
                </div>
              ) : null}
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h4 className="text-xs font-bold text-slate-500 uppercase mb-3">Key Signals</h4>
              <div className="flex flex-wrap gap-2">
                {user.barrier_status === "impaired" ? <SummaryPill text="barrier impaired" tone="red" /> : null}
                <SummaryPill text={`budget ${user.budget.total_monthly}`} tone="emerald" />
                {user.constraints?.includes("minimal_steps") ? <SummaryPill text="minimal steps" tone="blue" /> : null}
              </div>
            </div>
          </div>

          <CodeBlock title="UserVector.json" value={user} />
        </div>
      </div>
    </section>
  );

  const outputSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-800">2. 最终输出预览</h2>
          <p className="text-slate-500 mt-2">模拟系统最终回复（基于评分 + routine + conflicts）。</p>
        </div>

        <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6 space-y-6">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-bold text-slate-800">0) Chat (RAG)</h4>
              <button
                type="button"
                className="text-xs px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100"
                onClick={() =>
                  setChatQuery((q) =>
                    q.trim()
                      ? q
                      : `我敏感肌，想找 ${anchor.brand} ${anchor.name} 的平替。请给出推荐与取舍（trade-off）。`,
                  )
                }
              >
                Use current anchor
              </button>
            </div>
            <div className="mt-3 grid gap-3">
              <textarea
                className="w-full min-h-[90px] rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                placeholder="例如：我是重度敏感肌，最近脸特别疼。想买 Murad A醇精华，适合吗？"
                value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleChat}
                  disabled={isChatting || !chatQuery.trim()}
                  className="rounded-md bg-slate-900 text-white px-4 py-2 text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
                >
                  {isChatting ? "Thinking..." : "Ask"}
                </button>
                {chatError ? <span className="text-xs text-rose-600">{chatError}</span> : null}
              </div>
              {chatAnswer ? (
                <pre className="whitespace-pre-wrap text-sm text-slate-700 bg-white border border-slate-200 rounded-md p-3">
                  {chatAnswer}
                </pre>
              ) : null}
            </div>
          </div>

          <div>
            <h4 className="font-bold text-slate-800 mb-2">1) Diagnosis</h4>
            <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
              <li>
                Skin: <span className="font-mono">{formatSkinType(user.skin_type)}</span> / Barrier:{" "}
                <span className="font-mono">{user.barrier_status}</span>
              </li>
              <li>
                Anchor: <span className="font-mono">{anchor.brand}</span> — <span className="font-mono">{anchor.name}</span>
                {anchorScore.vetoed ? (
                  <span className="ml-2 text-rose-600 font-semibold">(VETO)</span>
                ) : (
                  <span className="ml-2 text-emerald-600 font-semibold">(OK)</span>
                )}
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold text-slate-800 mb-3">2) Recommendations</h4>
            <div className="space-y-2 text-sm text-slate-700">
              {run.routine.am.map((s, idx) => (
                <div key={`am-${s.step}-${s.sku.sku_id}`} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-bold text-slate-500">AM Step {idx + 1}</span>
                  <span className="bg-slate-100 text-slate-700 text-xs px-2 py-1 rounded font-bold">
                    {humanizeCategory(s.step)}
                  </span>
                  <span>
                    <strong>{s.sku.brand + " " + s.sku.name}</strong> ({formatCurrency(s.sku.price, s.sku.currency)})
                  </span>
                </div>
              ))}
              {run.routine.pm.map((s, idx) => (
                <div key={`pm-${s.step}-${s.sku.sku_id}`} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-bold text-slate-500">PM Step {idx + 1}</span>
                  <span className="bg-indigo-100 text-indigo-800 text-xs px-2 py-1 rounded font-bold">
                    {humanizeCategory(s.step)}
                  </span>
                  <span>
                    <strong>{s.sku.brand + " " + s.sku.name}</strong> ({formatCurrency(s.sku.price, s.sku.currency)})
                  </span>
                </div>
              ))}
            </div>
          </div>

          {run.routine.conflicts.length > 0 ? (
            <div className="bg-rose-50 p-4 rounded-lg border border-rose-100">
              <h4 className="font-bold text-rose-700 mb-2 text-sm">⚠️ Conflicts</h4>
              <ul className="text-sm text-rose-700 list-disc pl-5 space-y-1">
                {run.routine.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );

  const vectorsSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-800">3. SKU 多维向量化 (Deep Matrix)</h2>
          <p className="text-slate-500 mt-2">每个 SKU 被拆解为 Mechanism / Experience / Risk / Social / Engineering。</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex gap-4 items-start">
              <div className="w-16 h-16 bg-slate-100 rounded-lg flex items-center justify-center font-bold text-slate-500">
                {getInitials(anchor.brand)}
              </div>
              <div className="flex-1">
                <div className="flex justify-between">
                  <h3 className="font-bold text-slate-800">{anchor.brand + " " + anchor.name}</h3>
                  <span className="text-xs bg-emerald-50 text-emerald-600 px-2 py-1 rounded font-bold">
                    {formatCurrency(anchor.price, anchor.currency)}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">{humanizeCategory(anchor.category)}</p>
                <div className="mt-3 flex gap-2 flex-wrap">
                  {(anchor.actives ?? []).slice(0, 4).map((a) => (
                    <span key={a} className="text-[10px] border border-slate-200 px-1 rounded">
                      {a}
                    </span>
                  ))}
                  {anchor.risk_flags.map((r) => (
                    <span key={r} className="text-[10px] border border-rose-200 text-rose-700 bg-rose-50 px-1 rounded">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <h4 className="text-xs font-bold text-slate-500 uppercase">Mechanism Vector (0-1)</h4>
              {Object.entries(anchor.mechanism)
                .filter(([, v]) => typeof v === "number" && v > 0)
                .map(([k, v]) => (
                  <VectorBar key={k} label={k} value={v as number} colorClass="bg-indigo-500" />
                ))}

              <h4 className="text-xs font-bold text-slate-500 uppercase mt-6">Experience Vector (0-1)</h4>
              {"pilling_risk" in anchor.experience && typeof anchor.experience.pilling_risk === "number" ? (
                <VectorBar
                  label="Pilling Risk"
                  value={anchor.experience.pilling_risk}
                  colorClass="bg-rose-500"
                  monoClass="text-rose-600"
                />
              ) : (
                <div className="text-xs text-slate-500">No experience signals recorded.</div>
              )}
              {"stickiness" in anchor.experience && typeof anchor.experience.stickiness === "number" ? (
                <VectorBar label="Stickiness" value={anchor.experience.stickiness} colorClass="bg-rose-500" monoClass="text-rose-600" />
              ) : null}
            </div>
          </div>

          <CodeBlock title={`SkuVector_${anchor.sku_id}.json`} value={anchor} />
        </div>
      </div>
    </section>
  );

  const scoringSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-800">4. 评分模型与冲突裁决</h2>
          <p className="text-slate-500 mt-2">Total = 0.3*Science + 0.6*Social + 0.1*Engineering (with VETO).</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-xl border-t-4 border-emerald-500 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Science Score</h3>
                <div className="text-xs text-slate-400">Mechanism ↔ Goals</div>
              </div>
              <div className="text-2xl font-bold text-emerald-600">{Math.round(anchorScore.science)}</div>
            </div>
            <ul className="space-y-2 text-xs text-slate-600">
              {user.goals.slice(0, 4).map((g) => (
                <li key={g.track} className="flex items-center justify-between">
                  <span className="font-mono">{g.track}</span>
                  <span className="font-mono text-slate-500">{(anchor.mechanism[g.track] ?? 0).toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white p-6 rounded-xl border-t-4 border-rose-500 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Social Score</h3>
                <div className="text-xs text-slate-400">Platform weighted</div>
              </div>
              <div className="text-2xl font-bold text-rose-600">{Math.round(anchorScore.social)}</div>
            </div>
            <ul className="space-y-2 text-xs text-slate-600">
              {PLATFORM_OPTIONS.map((p) => (
                <li key={p} className="flex items-center justify-between">
                  <span className="font-mono">{p}</span>
                  <span className="font-mono text-slate-500">
                    w={formatPercent(user.platform_weights[p] ?? 0)} • s={(anchor.social_stats.platform_scores[p] ?? 0).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white p-6 rounded-xl border-t-4 border-slate-500 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Engineering</h3>
                <div className="text-xs text-slate-400">Usability / stability</div>
              </div>
              <div className="text-2xl font-bold text-slate-600">{Math.round(anchorScore.engineering)}</div>
            </div>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="flex items-center justify-between">
                <span className="font-mono">usability_penalty</span>
                <span className="font-mono text-slate-500">{(anchor.engineering?.usability_penalty ?? 0.5).toFixed(2)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="font-mono">burn_rate</span>
                <span className="font-mono text-slate-500">{(anchor.social_stats.burn_rate ?? 0).toFixed(2)}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 bg-slate-900 text-white p-6 rounded-xl flex items-center gap-6 shadow-lg">
          <div className="text-center min-w-[110px]">
            <div className="text-xs text-slate-400 uppercase">Total Score</div>
            <div className={["text-4xl font-bold", anchorScore.vetoed ? "text-rose-400" : "text-indigo-400"].join(" ")}>
              {anchorScore.total.toFixed(1)}
            </div>
          </div>
          <div className="h-10 w-px bg-slate-700" />
          <div>
            <h4 className="font-bold text-indigo-300 mb-1">Adjudication</h4>
            <p className="text-xs text-slate-300 leading-relaxed">
              {anchorScore.vetoed
                ? `VETO: ${anchorScore.veto_reason ?? "Not recommended for impaired barrier."}`
                : "Weighted blend of science + social + engineering. Use dupes to trade cost vs experience."}
            </p>
          </div>
        </div>

        {recommendedDupe ? (
          <div className="mt-6 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <div className="text-xs text-slate-500 uppercase font-bold mb-1">Recommended Dupe (Cheaper)</div>
                <div className="text-lg font-bold text-slate-900 truncate">
                  {recommendedDupe.sku.brand} — {recommendedDupe.sku.name}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {formatCurrency(recommendedDupe.sku.price, recommendedDupe.sku.currency)} • similarity{" "}
                  <span className="font-mono">{recommendedDupe.similarity.toFixed(2)}</span>
                </div>
                <div className="mt-3 text-sm text-slate-700">{recommendedDupe.tradeoff_note}</div>
              </div>

              <button
                type="button"
                className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  setSelectedDupeId(recommendedDupe.sku.sku_id);
                  setActiveView("dupes");
                }}
              >
                Compare →
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );

  const dupesSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-800">5. Dupe Discovery (Vector Search)</h2>
          <p className="text-slate-500 mt-2">Cosine similarity over mechanism vectors, filtered to cheaper SKUs.</p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <div className="flex flex-wrap gap-2 mb-6">
            {dupes.map((d) => (
              <button
                key={d.sku.sku_id}
                type="button"
                className={[
                  "text-xs font-semibold px-3 py-1.5 rounded border transition-colors",
                  (selectedDupe?.sku_id ?? "") === d.sku.sku_id
                    ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                    : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50",
                ].join(" ")}
                onClick={() => setSelectedDupeId(d.sku.sku_id)}
              >
                {d.sku.brand}: {d.sku.name} • sim {d.similarity.toFixed(2)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div className="font-bold text-slate-800">{anchor.brand + " " + anchor.name}</div>
                <div className="text-xs font-bold text-slate-600">{formatCurrency(anchor.price, anchor.currency)}</div>
              </div>
              <div className="text-xs text-slate-500 mt-1">{humanizeCategory(anchor.category)}</div>
              <div className="mt-4 space-y-3">
                {Object.entries(anchor.mechanism)
                  .filter(([, v]) => typeof v === "number" && v > 0)
                  .map(([k, v]) => (
                    <VectorBar key={k} label={k} value={v as number} colorClass="bg-slate-700" monoClass="text-slate-700" />
                  ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-5">
              {selectedDupe ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-slate-800">{selectedDupe.brand + " " + selectedDupe.name}</div>
                    <div className="text-xs font-bold text-emerald-700">{formatCurrency(selectedDupe.price, selectedDupe.currency)}</div>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{humanizeCategory(selectedDupe.category)}</div>
                  <div className="mt-4 space-y-3">
                    {Object.entries(selectedDupe.mechanism)
                      .filter(([, v]) => typeof v === "number" && v > 0)
                      .map(([k, v]) => (
                        <VectorBar key={k} label={k} value={v as number} colorClass="bg-indigo-500" monoClass="text-indigo-700" />
                      ))}
                  </div>
                </>
              ) : (
                <div className="text-sm text-slate-500">No dupe selected.</div>
              )}
            </div>
          </div>

          <div className="mt-6 bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-700">
            <div className="font-bold text-slate-800 mb-1">Trade-off note</div>
            <div className="text-slate-600">
              {dupes.find((d) => d.sku.sku_id === selectedDupe?.sku_id)?.tradeoff_note ??
                "Select a dupe to see trade-offs."}
            </div>
          </div>
        </div>
      </div>
    </section>
  );

  const routineSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-800">6. Routine &amp; Compatibility</h2>
            <p className="text-slate-500 mt-2">AM/PM steps generated by the High-Low routine engine.</p>
          </div>
          <div className="text-lg font-bold text-emerald-700">
            Total: {formatCurrency(run.routine.estimated_total, "USD")}
          </div>
        </div>

        {run.routine.conflicts.length > 0 ? (
          <div className="mb-6 bg-rose-50 border border-rose-100 rounded-lg p-4 text-rose-700">
            <div className="font-bold mb-1">⚠️ Compatibility conflicts</div>
            <ul className="list-disc pl-5 text-sm space-y-1">
              {run.routine.conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="relative">
            <div className="flex items-center gap-2 mb-6">
              <Sun className="w-5 h-5 text-amber-500" />
              <h3 className="font-bold text-slate-800">AM Routine</h3>
            </div>
            <div className="absolute left-4 top-10 bottom-0 w-0.5 bg-slate-200" />
            <div className="space-y-6">
              {run.routine.am.map((s) => (
                <div key={`am-${s.step}-${s.sku.sku_id}`} className="relative pl-10">
                  <div className="absolute left-2.5 top-2 w-3 h-3 bg-white border-2 border-slate-300 rounded-full z-10" />
                  <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                    <h4 className="font-bold text-slate-700 text-sm">{humanizeCategory(s.step)}</h4>
                    <div className="text-xs text-slate-500">
                      {s.sku.brand} — {s.sku.name} ({formatCurrency(s.sku.price, s.sku.currency)})
                    </div>
                    {s.notes?.length ? <div className="mt-2 text-[10px] text-slate-500">{s.notes.join(" ")}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="flex items-center gap-2 mb-6">
              <Moon className="w-5 h-5 text-indigo-500" />
              <h3 className="font-bold text-slate-800">PM Routine</h3>
            </div>
            <div className="absolute left-4 top-10 bottom-0 w-0.5 bg-slate-200" />
            <div className="space-y-6">
              {run.routine.pm.map((s) => (
                <div key={`pm-${s.step}-${s.sku.sku_id}`} className="relative pl-10">
                  <div className="absolute left-2.5 top-2 w-3 h-3 bg-white border-2 border-slate-300 rounded-full z-10" />
                  <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                    <h4 className="font-bold text-slate-700 text-sm">{humanizeCategory(s.step)}</h4>
                    <div className="text-xs text-slate-500">
                      {s.sku.brand} — {s.sku.name} ({formatCurrency(s.sku.price, s.sku.currency)})
                    </div>
                    {s.notes?.length ? <div className="mt-2 text-[10px] text-slate-500">{s.notes.join(" ")}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );

  const budgetSection = (
    <section className="w-full h-full overflow-y-auto p-8 fade-in">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex justify-between items-end">
          <div>
            <h2 className="text-2xl font-bold text-slate-800">7. High-Low 预算分配</h2>
            <p className="text-slate-500 mt-2">预算按“停留时间短 → 平价；功效品 → 高效”分配。</p>
          </div>
          <div className="text-xl font-bold text-emerald-600">Total: ~{formatCurrency(run.routine.estimated_total, "USD")}</div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border-t-4 border-slate-300 shadow-sm">
            <div className="flex justify-between text-xs font-bold text-slate-400 uppercase mb-2">
              <span>Cleanser</span>
              <span>15%</span>
            </div>
            <div className="text-2xl font-bold text-slate-700 mb-1">
              {formatCurrency(user.budget.total_monthly * 0.15, "USD")}
            </div>
            <div className="text-sm font-bold text-slate-800">{run.routine.am.find((s) => s.step === "cleanser")?.sku.brand ?? "—"}</div>
            <p className="text-xs text-slate-500 mt-2">停留时间短，只要温和不伤屏障。</p>
          </div>

          <div className="bg-indigo-50 p-4 rounded-xl border-t-4 border-indigo-500 shadow-sm">
            <div className="flex justify-between text-xs font-bold text-indigo-400 uppercase mb-2">
              <span>Treatment</span>
              <span>35%</span>
            </div>
            <div className="text-2xl font-bold text-indigo-700 mb-1">
              {formatCurrency(user.budget.total_monthly * 0.35, "USD")}
            </div>
            <div className="text-sm font-bold text-slate-800">{run.routine.pm.find((s) => s.step === "treatment")?.sku.brand ?? "—"}</div>
            <p className="text-xs text-indigo-800/70 mt-2">核心功效区：按目标优先级押注。</p>
          </div>

          <div className="bg-white p-4 rounded-xl border-t-4 border-emerald-500 shadow-sm">
            <div className="flex justify-between text-xs font-bold text-emerald-400 uppercase mb-2">
              <span>Repair</span>
              <span>20%</span>
            </div>
            <div className="text-2xl font-bold text-emerald-700 mb-1">
              {formatCurrency(user.budget.total_monthly * 0.2, "USD")}
            </div>
            <div className="text-sm font-bold text-slate-800">
              {run.routine.am.find((s) => s.step === "moisturizer")?.sku.brand ?? "—"}
            </div>
            <p className="text-xs text-slate-500 mt-2">基础修护即可；屏障优先。</p>
          </div>

          <div className="bg-white p-4 rounded-xl border-t-4 border-amber-500 shadow-sm">
            <div className="flex justify-between text-xs font-bold text-amber-400 uppercase mb-2">
              <span>Sunscreen</span>
              <span>30%</span>
            </div>
            <div className="text-2xl font-bold text-amber-700 mb-1">
              {formatCurrency(user.budget.total_monthly * 0.3, "USD")}
            </div>
            <div className="text-sm font-bold text-slate-800">
              {run.routine.am.find((s) => s.step === "sunscreen")?.sku.brand ?? "—"}
            </div>
            <p className="text-xs text-slate-500 mt-2">提亮上限在防晒；选肤感好才会用。</p>
          </div>
        </div>

        <div className="mt-8 bg-slate-100 p-4 rounded-lg border border-slate-200 flex gap-4">
          <div className="text-slate-500 mt-0.5">✓</div>
          <div>
            <h4 className="text-sm font-bold text-slate-700">组合校验通过</h4>
            <p className="text-xs text-slate-500 mt-1">
              已检测：平价洁面优先温和，功效品按目标匹配；若出现冲突会在 Routine 中提示。
            </p>
          </div>
        </div>
      </div>
    </section>
  );

  const view = (() => {
    switch (activeView) {
      case "input":
        return inputSection;
      case "output":
        return outputSection;
      case "vectors":
        return vectorsSection;
      case "scoring":
        return scoringSection;
      case "dupes":
        return dupesSection;
      case "routine":
        return routineSection;
      case "budget":
        return budgetSection;
      default:
        return inputSection;
    }
  })();

  return (
    <div className="flex h-screen overflow-hidden text-sm">
      <SidebarNav activeView={activeView} onChange={setActiveView} />

      <main className="flex-1 flex flex-col overflow-hidden bg-[#f8fafc] relative">
        <Header subtitle={subtitle} />
        {view}
      </main>
    </div>
  );
}

"use client";

import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AnalyzingView } from "@/components/consult/AnalyzingView";
import { ConsultWizard, type ConsultWizardAnswers } from "@/components/consult/ConsultWizard";
import { ReportCard } from "@/components/consult/ReportCard";
import { SkinTracker } from "@/components/SkinTracker";

type ViewState = "wizard" | "analyzing" | "report";

function buildSyntheticPrompt(data: ConsultWizardAnswers) {
  const skin =
    data.skin_type === "combo" ? "combination" : data.skin_type === "sensitive" ? "sensitive" : data.skin_type;

  const concerns = data.concerns
    .map((c) => {
      switch (c) {
        case "dark_spots":
          return "dark spots";
        default:
          return c;
      }
    })
    .join(", ");

  const barrier = data.barrier_status === "strong" ? "healthy/strong" : "impaired (stinging/red)";

  const budget = data.monthly_budget_cny === 1000 ? "1000+ CNY" : `${data.monthly_budget_cny} CNY`;

  return [
    `I have ${skin} skin.`,
    `My top concerns are ${concerns}.`,
    `My barrier is ${barrier}.`,
    `My budget is ${budget} per month.`,
    "Please recommend an AM/PM skincare routine within my budget. Keep it practical and explain why each step helps.",
  ].join(" ");
}

export default function ConsultPage() {
  const [view, setView] = useState<ViewState>("wizard");
  const [profile, setProfile] = useState<ConsultWizardAnswers | null>(null);

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: "/api/chat",
        body: { stream: true, llm_provider: "gemini", llm_model: "gemini-2.5-flash" },
      }),
    [],
  );

  const { messages, sendMessage, status, error, setMessages, clearError } = useChat({ transport });

  const isStreaming = status === "submitted" || status === "streaming";

  const latestAssistant = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const text =
      last?.parts
        ?.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("") ?? "";

    return text.trim();
  }, [messages]);

  const handleRestart = useCallback(() => {
    setProfile(null);
    setMessages([]);
    setView("wizard");
    clearError();
  }, [clearError, setMessages]);

  const handleWizardComplete = useCallback(
    async (data: ConsultWizardAnswers) => {
      setProfile(data);
      setMessages([]);
      clearError();
      setView("analyzing");

      const prompt = buildSyntheticPrompt(data);
      await sendMessage({ text: prompt });
    },
    [clearError, sendMessage, setMessages],
  );

  useEffect(() => {
    if (view !== "analyzing") return;
    if (latestAssistant.length > 0) setView("report");
  }, [latestAssistant.length, view]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-slate-100 px-4 py-8">
      <div className="mx-auto w-full max-w-sm">
        {view === "wizard" ? <ConsultWizard onComplete={handleWizardComplete} /> : null}
        {view === "analyzing" ? <AnalyzingView /> : null}
        {view === "report" && profile ? (
          <>
            <ReportCard
              profile={profile}
              answer={latestAssistant || "No response yet."}
              isStreaming={isStreaming}
              onRestart={handleRestart}
            />
            <div className="mt-6 pb-[calc(env(safe-area-inset-bottom)+7rem)]">
              <SkinTracker />
            </div>
          </>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error.message || String(error)}
          </div>
        ) : null}
      </div>
    </main>
  );
}

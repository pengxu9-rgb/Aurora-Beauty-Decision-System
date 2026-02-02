"use client";

import type { SkinIdentitySnapshot } from "@/actions/userProfile";
import { getSkinIdentitySnapshot, setUserConcerns } from "@/actions/userProfile";
import { ActionChips, type ActionChip } from "@/components/chat/ActionChips";
import { RoutineTimeline, type RoutineRec } from "@/components/chat/RoutineTimeline";
import { SkinIdentityCard } from "@/components/chat/SkinIdentityCard";
import { cn } from "@/lib/cn";
import { bffRequest, normalizeAuroraLang, type AuroraLang, type BffCard, type BffEnvelope, type SuggestedChip } from "@/lib/pivotaAgentBff";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

function makeId(prefix: string) {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  return `${prefix}_${cryptoObj?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function safeUuid() {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  return cryptoObj?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const UID_KEY = "aurora_uid";
const COOKIE_NAME = "aurora_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function readCookie(name: string) {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (!part) continue;
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function getOrCreateAuroraUid() {
  if (typeof window === "undefined") return null;

  const fromCookie = readCookie(COOKIE_NAME);
  if (fromCookie && fromCookie.trim()) {
    window.localStorage.setItem(UID_KEY, fromCookie.trim());
    return fromCookie.trim();
  }

  const existing = window.localStorage.getItem(UID_KEY);
  if (existing && existing.trim()) return existing.trim();

  const cryptoObj = globalThis.crypto as Crypto | undefined;
  const uid = (cryptoObj?.randomUUID?.() ?? `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`).slice(0, 64);
  window.localStorage.setItem(UID_KEY, uid);
  return uid;
}

function setAuroraUidCookie(uid: string) {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(uid)}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

export function AuroraChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: makeId("a"),
      role: "assistant",
      content:
        "Hi — I’m Aurora.\n\nTell me what you want to solve today (acne, redness, dark spots, anti‑aging), or paste a product name/link and ask “is this right for me?”\n\nI’ll ask a quick safety profile *only when needed*.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [suggestedChips, setSuggestedChips] = useState<SuggestedChip[]>([]);
  const [cardFeed, setCardFeed] = useState<BffCard[]>([]);
  const [sessionState, setSessionState] = useState<string | null>(null);
  const traceIdRef = useRef<string>(safeUuid());
  const briefIdRef = useRef<string>(safeUuid());
  const pendingGateMessageRef = useRef<string | null>(null);
  const [lang, setLang] = useState<AuroraLang>(() => normalizeAuroraLang(typeof navigator !== "undefined" ? navigator.language : "EN"));

  const listRef = useRef<HTMLDivElement | null>(null);
  const selfieInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  const [userId, setUserId] = useState<string | null>(null);
  const [skinIdentity, setSkinIdentity] = useState<SkinIdentitySnapshot | null>(null);
  const [isIdentityLoading, setIsIdentityLoading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const [diagnosisExpanded, setDiagnosisExpanded] = useState(true);
  const [diagnosisProgressOverride, setDiagnosisProgressOverride] = useState<number>(0);
  const prevDiagnosisProgress = useRef<number>(0);

  const lastMessageId = useMemo(() => messages[messages.length - 1]?.id ?? null, [messages]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [lastMessageId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const diagnosisProgressFromProfile = useMemo(() => {
    if (!skinIdentity) return 0;
    let done = 0;
    const total = 3;
    if (typeof skinIdentity.skinType === "string" && skinIdentity.skinType.trim()) done += 1;
    if (typeof skinIdentity.barrierStatus === "string" && skinIdentity.barrierStatus.trim()) done += 1;
    if (Array.isArray(skinIdentity.concerns) && skinIdentity.concerns.length > 0) done += 1;
    return Math.round((done / total) * 100);
  }, [skinIdentity]);

  const diagnosisProgress = useMemo(
    () => Math.max(diagnosisProgressFromProfile, diagnosisProgressOverride),
    [diagnosisProgressFromProfile, diagnosisProgressOverride],
  );

  useEffect(() => {
    const prev = prevDiagnosisProgress.current;
    prevDiagnosisProgress.current = diagnosisProgress;
    if (prev >= 100 || diagnosisProgress < 100) return;
    // Auto-collapse once diagnosis reaches "complete" (no more progress to show).
    const t = window.setTimeout(() => setDiagnosisExpanded(false), 700);
    return () => window.clearTimeout(t);
  }, [diagnosisProgress]);

  const refreshIdentity = useCallback(async (uid: string) => {
    setIsIdentityLoading(true);
    setSendError(null);
    try {
      const snapshot = await getSkinIdentitySnapshot(uid);
      setSkinIdentity(snapshot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load profile";
      setSendError(msg);
    } finally {
      setIsIdentityLoading(false);
    }
  }, []);

  useEffect(() => {
    const uid = getOrCreateAuroraUid();
    if (!uid) return;
    setAuroraUidCookie(uid);
    setUserId(uid);
    void refreshIdentity(uid);
  }, [refreshIdentity]);

  useEffect(() => {
    return () => {
      if (avatarUrl) URL.revokeObjectURL(avatarUrl);
    };
  }, [avatarUrl]);

  const pushMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const applyEnvelope = useCallback(
    (envelope: BffEnvelope, { userMessage, gateMessage }: { userMessage?: string; gateMessage?: string } = {}) => {
      if (envelope.assistant_message && typeof envelope.assistant_message.content === "string" && envelope.assistant_message.content.trim()) {
        pushMessage({
          id: makeId("a"),
          role: "assistant",
          content: envelope.assistant_message.content.trim(),
        });
      }

      setSuggestedChips(Array.isArray(envelope.suggested_chips) ? envelope.suggested_chips : []);

      const cards = Array.isArray(envelope.cards) ? envelope.cards : [];
      if (cards.length) setCardFeed((prev) => [...prev, ...cards].slice(-60));

      const nextState =
        envelope.session_patch && typeof envelope.session_patch === "object" && typeof (envelope.session_patch as any).next_state === "string"
          ? String((envelope.session_patch as any).next_state)
          : null;
      if (nextState) setSessionState(nextState);

      const hasDiagnosisGate = cards.some((c) => c && typeof c === "object" && (c as any).type === "diagnosis_gate");
      pendingGateMessageRef.current = hasDiagnosisGate ? (userMessage || gateMessage || pendingGateMessageRef.current) : null;
    },
    [pushMessage],
  );

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;
      if (!userId) {
        setSendError("Missing user id. Please refresh the page.");
        return;
      }

      setIsSending(true);
      setSendError(null);
      setSuggestedChips([]);
      // Keep "diagnosis complete" sticky once reached, so the banner doesn't re-open every message.
      setDiagnosisProgressOverride((prev) => (prev >= 100 ? 100 : 0));

      const userMessage: ChatMessage = { id: makeId("u"), role: "user", content: trimmed };
      setMessages((prev) => {
        const next = [...prev, userMessage];
        return next;
      });
      setInput("");

      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 25000);

        const requestLang: AuroraLang = /[\u4e00-\u9fff]/.test(trimmed) ? "CN" : lang;
        if (requestLang !== lang) setLang(requestLang);

        const envelope = await bffRequest<BffEnvelope>("/v1/chat", {
          uid: userId,
          lang: requestLang,
          traceId: traceIdRef.current,
          briefId: briefIdRef.current,
          method: "POST",
          body: {
            message: trimmed,
            session: { state: sessionState, trace_id: traceIdRef.current, brief_id: briefIdRef.current },
          },
          signal: controller.signal,
        });
        window.clearTimeout(timeout);

        applyEnvelope(envelope, { userMessage: trimmed });
        if (userId) void refreshIdentity(userId);
      } catch (e) {
        const err =
          e instanceof DOMException && e.name === "AbortError"
            ? "Request timed out. Please try again."
            : e instanceof Error
              ? e.message
              : "Failed to reach pivota-agent";
        setSendError(err);
        pushMessage({ id: makeId("a"), role: "assistant", content: `Sorry — ${err}.` });
      } finally {
        setIsSending(false);
      }
    },
    [applyEnvelope, isSending, lang, pushMessage, refreshIdentity, sessionState, userId],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await sendText(input);
    },
    [input, sendText],
  );

  const quickActions = useMemo(
    () => [
      { label: "Start Skin Diagnosis", text: "I want a quick diagnosis of my skin type, barrier status, and goals." },
      { label: "Check a product", text: "I want to evaluate a product. I’ll paste the name/link next." },
      { label: "Redness / irritation help", text: "My skin feels irritated (stinging/redness). Help me troubleshoot safely." },
      { label: "中文", text: "我们用中文聊。我想先说一下我的皮肤情况。" },
    ],
    [],
  );

  const handleConfirmProfile = useCallback(async () => {
    if (!userId) return;
    await refreshIdentity(userId);
    pushMessage({
      id: makeId("a"),
      role: "assistant",
      content:
        "Profile confirmed. Next: paste a product name/link for a safety+fit check, or tell me your main goal (acne / redness / dark spots / anti‑aging).",
    });
  }, [pushMessage, refreshIdentity, userId]);

  const handleUploadSelfie = useCallback(() => {
    selfieInputRef.current?.click();
  }, []);

  const handleSelfiePicked = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (avatarUrl) URL.revokeObjectURL(avatarUrl);
      const url = URL.createObjectURL(file);
      setAvatarUrl(url);
      pushMessage({
        id: makeId("a"),
        role: "assistant",
        content:
          "Selfie selected (preview). CV-based analysis is coming next — for now, please answer the quick profile questions so I can stay safe and consistent.",
      });
    },
    [avatarUrl, pushMessage],
  );

  const handleConcernsChange = useCallback(
    async (next: string[]) => {
      if (!userId) return;
      setSkinIdentity((prev) => (prev ? { ...prev, concerns: next } : prev));
      try {
        const updated = await setUserConcerns(userId, next);
        setSkinIdentity(updated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to update concerns";
        setSendError(msg);
      }
    },
    [userId],
  );

  const actionChips = useMemo<ActionChip[]>(
    () =>
      suggestedChips.map((c) => ({
        id: c.chip_id,
        label: c.label,
        kind: c.kind,
        text: typeof c.data?.reply_text === "string" ? c.data.reply_text : typeof c.data?.replyText === "string" ? c.data.replyText : undefined,
        data: c.data,
      })),
    [suggestedChips],
  );

  const sendChip = useCallback(
    async (chip: ActionChip) => {
      if (!userId || isSending) return;

      setIsSending(true);
      setSendError(null);
      setSuggestedChips([]);

      // Show the tap as a user message, but keep gating context separately.
      pushMessage({ id: makeId("u"), role: "user", content: chip.text?.trim() || chip.label });

      const isProfileChip = chip.id.startsWith("profile.") || Boolean(chip.data && typeof chip.data === "object" && "profile_patch" in chip.data);
      const replyText = typeof chip.data?.reply_text === "string" ? chip.data.reply_text.trim() : typeof chip.data?.replyText === "string" ? chip.data.replyText.trim() : "";
      const gateMessage = pendingGateMessageRef.current || undefined;
      const messageForUpstream = replyText || (isProfileChip ? gateMessage : chip.text?.trim() || chip.label);

      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 25000);

        const envelope = await bffRequest<BffEnvelope>("/v1/chat", {
          uid: userId,
          lang,
          traceId: traceIdRef.current,
          briefId: briefIdRef.current,
          method: "POST",
          body: {
            ...(messageForUpstream ? { message: messageForUpstream } : {}),
            action: { action_id: chip.id, kind: "chip", data: chip.data ?? {} },
            session: { state: sessionState, trace_id: traceIdRef.current, brief_id: briefIdRef.current },
          },
          signal: controller.signal,
        });
        window.clearTimeout(timeout);

        applyEnvelope(envelope, { userMessage: isProfileChip ? undefined : messageForUpstream, gateMessage });
        void refreshIdentity(userId);
      } catch (e) {
        const err =
          e instanceof DOMException && e.name === "AbortError"
            ? "Request timed out. Please try again."
            : e instanceof Error
              ? e.message
              : "Failed to reach pivota-agent";
        setSendError(err);
        pushMessage({ id: makeId("a"), role: "assistant", content: `Sorry — ${err}.` });
      } finally {
        setIsSending(false);
      }
    },
    [applyEnvelope, isSending, lang, pushMessage, refreshIdentity, sessionState, userId],
  );

  const requestRoutine = useCallback(async () => {
    if (!userId || isSending) return;

    setIsSending(true);
    setSendError(null);
    setSuggestedChips([]);

    pushMessage({ id: makeId("u"), role: "user", content: lang === "CN" ? "生成护肤流程（显式）" : "Generate routine (explicit)" });

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30000);

      const focus = skinIdentity?.concerns?.[0] ?? undefined;
      const envelope = await bffRequest<BffEnvelope>("/v1/reco/generate", {
        uid: userId,
        lang,
        traceId: traceIdRef.current,
        briefId: briefIdRef.current,
        method: "POST",
        body: { ...(focus ? { focus } : {}) },
        signal: controller.signal,
      });
      window.clearTimeout(timeout);

      applyEnvelope(envelope, { gateMessage: "recommend" });
      void refreshIdentity(userId);
    } catch (e) {
      const err =
        e instanceof DOMException && e.name === "AbortError"
          ? "Request timed out. Please try again."
          : e instanceof Error
            ? e.message
            : "Failed to reach pivota-agent";
      setSendError(err);
      pushMessage({ id: makeId("a"), role: "assistant", content: `Sorry — ${err}.` });
    } finally {
      setIsSending(false);
    }
  }, [applyEnvelope, isSending, lang, pushMessage, refreshIdentity, skinIdentity?.concerns, userId]);

  const renderBffCard = useCallback((card: BffCard) => {
    const payload = card.payload ?? {};

    if (card.type === "recommendations") {
      const recs = Array.isArray((payload as any).recommendations) ? ((payload as any).recommendations as any[]) : [];
      const am = recs
        .filter((r) => r && typeof r === "object" && (r as any).slot === "am")
        .map((r) => {
          const { slot: _slot, ...rest } = r as any;
          return rest;
        });
      const pm = recs
        .filter((r) => r && typeof r === "object" && (r as any).slot === "pm")
        .map((r) => {
          const { slot: _slot, ...rest } = r as any;
          return rest;
        });

      const routine: RoutineRec = { am, pm };
      return <RoutineTimeline key={card.card_id} title="Your Routine" routine={routine} />;
    }

    if (card.type === "product_analysis") {
      const verdict = (payload as any)?.assessment?.verdict ?? null;
      const evidence = (payload as any)?.evidence ?? null;
      const keyIng = Array.isArray(evidence?.science?.key_ingredients) ? evidence.science.key_ingredients : [];
      const riskNotes = Array.isArray(evidence?.science?.risk_notes) ? evidence.science.risk_notes : [];

      return (
        <section key={card.card_id} className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Product analysis">
          <div className="text-xs font-semibold text-slate-900">Product Deep Scan</div>
          {verdict ? <div className="mt-1 text-sm font-semibold text-slate-900">Verdict: {String(verdict)}</div> : null}
          {keyIng.length ? (
            <div className="mt-2 text-xs text-slate-700">
              <span className="font-semibold">Key ingredients:</span> {keyIng.slice(0, 8).join(", ")}
            </div>
          ) : null}
          {riskNotes.length ? (
            <div className="mt-2 text-xs text-rose-700">
              <span className="font-semibold">Risk notes:</span> {riskNotes.slice(0, 6).join(" · ")}
            </div>
          ) : null}
        </section>
      );
    }

    if (card.type === "dupe_compare") {
      const tradeoffs = Array.isArray((payload as any).tradeoffs) ? ((payload as any).tradeoffs as any[]) : [];
      return (
        <section key={card.card_id} className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Dupe compare">
          <div className="text-xs font-semibold text-slate-900">Dupe Compare</div>
          {tradeoffs.length ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-slate-700">
              {tradeoffs.slice(0, 6).map((t, idx) => (
                <li key={idx}>{String(t)}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-xs text-slate-500">No tradeoffs returned.</div>
          )}
        </section>
      );
    }

    if (card.type === "diagnosis_gate") {
      const missing = Array.isArray((payload as any).missing_fields) ? ((payload as any).missing_fields as any[]) : [];
      return (
        <section key={card.card_id} className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm" aria-label="Diagnosis gate">
          <div className="text-xs font-semibold text-indigo-900">Diagnosis first</div>
          {missing.length ? <div className="mt-1 text-xs text-indigo-800">Missing: {missing.join(", ")}</div> : null}
        </section>
      );
    }

    if (card.type === "gate_notice") {
      const missing = Array.isArray((card as any).field_missing) ? ((card as any).field_missing as any[]) : [];
      return (
        <section key={card.card_id} className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm" aria-label="Gate notice">
          <div className="text-xs font-semibold text-amber-900">Gate notice</div>
          {missing.length ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-amber-800">
              {missing.slice(0, 6).map((m, idx) => (
                <li key={idx}>
                  {String((m as any).field)}: {String((m as any).reason)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      );
    }

    if (card.type === "error") {
      return (
        <section key={card.card_id} className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-sm" aria-label="Error">
          <div className="text-xs font-semibold text-rose-900">Error</div>
          <div className="mt-1 text-xs text-rose-800">{String((payload as any).error ?? "unknown_error")}</div>
        </section>
      );
    }

    return (
      <details key={card.card_id} className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-xs font-semibold text-slate-900">{card.type}</summary>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-50 p-3 text-[11px] text-slate-700">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    );
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-slate-100">
      <div className="mx-auto w-full max-w-sm">
        <div className="px-4 pt-6 pb-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900">Aurora Chat</div>
              <div className="mt-0.5 text-xs text-slate-500">
                Chat-first skincare partner · <a className="underline" href="/chat">Chat</a> ·{" "}
                <a className="underline" href="/consult">Consult</a> · <a className="underline" href="/lab">Lab</a>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (avatarUrl) URL.revokeObjectURL(avatarUrl);
                setMessages([
                  {
                    id: makeId("a"),
                    role: "assistant",
                    content:
                      "Hi — I’m Aurora.\n\nTell me what you want to solve today (acne, redness, dark spots, anti‑aging), or paste a product name/link and ask “is this right for me?”\n\nI’ll ask a quick safety profile *only when needed*.",
                  },
                ]);
                setSuggestedChips([]);
                setCardFeed([]);
                setSessionState(null);
                pendingGateMessageRef.current = null;
                setSendError(null);
                setInput("");
                setDiagnosisProgressOverride(0);
                setAvatarUrl(null);
                if (userId) void refreshIdentity(userId);
              }}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900"
            >
              Reset
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          className="px-4 pb-28 overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 56px)" }}
        >
          <input
            ref={selfieInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => handleSelfiePicked(e.target.files?.[0] ?? null)}
          />

          {skinIdentity && diagnosisProgress < 100 ? (
            <div className="mb-3 sticky top-0 z-20 pt-2 -mt-2">
              <div className="rounded-2xl border border-slate-200 bg-white/90 backdrop-blur shadow-sm">
                <button
                  type="button"
                  onClick={() => setDiagnosisExpanded((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold text-slate-900">Skin Diagnosis</div>
                      <span className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                        {diagnosisProgress >= 100 ? "Ready" : `${diagnosisProgress}%`}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${diagnosisProgress}%` }} />
                    </div>
                  </div>
                  <div className="shrink-0 text-slate-500">
                    {diagnosisExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </button>
              </div>

              {diagnosisExpanded ? (
                <div className="mt-3">
                  <SkinIdentityCard
                    name="You"
                    avatarUrl={avatarUrl}
                    status={skinIdentity.status}
                    resilienceScore={skinIdentity.resilienceScore}
                    hydration={skinIdentity.hydration}
                    sebum={skinIdentity.sebum}
                    sensitivity={skinIdentity.sensitivity}
                    concerns={skinIdentity.concerns}
                    onConcernsChange={handleConcernsChange}
                    onConfirmProfile={handleConfirmProfile}
                    onUploadSelfie={handleUploadSelfie}
                  />
                  {isIdentityLoading ? <div className="mt-2 text-[11px] text-slate-500">Updating profile…</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {isSending ? (
            <div className="mb-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 text-slate-700 animate-spin" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold tracking-wide text-slate-500">AURORA ENGINE</div>
                  <div className="text-sm font-semibold text-slate-900">Checking safety protocols…</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                      ✓ Profile loaded
                    </span>
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                      ✓ Ingredient DB
                    </span>
                    <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">
                      Checking VETO rules
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-sm",
                  m.role === "user"
                    ? "ml-auto max-w-[92%] border-indigo-200 bg-indigo-50 text-slate-900"
                    : "mr-auto max-w-[92%] border-slate-200 bg-white text-slate-900",
                )}
              >
                <div className="prose prose-sm max-w-none prose-slate">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              </div>
            ))}
          </div>

          {cardFeed.length ? (
            <div className="space-y-3">
              {cardFeed.slice(-12).map((c) => renderBffCard(c))}
            </div>
          ) : null}

          {messages.length <= 1 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {quickActions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => void sendText(a.text)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void requestRoutine()}
              disabled={isSending}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                isSending ? "border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed" : "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100",
              )}
            >
              {lang === "CN" ? "生成护肤流程" : "Generate routine"}
            </button>
          </div>

          <ActionChips actions={actionChips} onSelect={(a) => void sendChip(a)} />

          {sendError ? (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
              {sendError}
            </div>
          ) : null}
        </div>

        <form
          onSubmit={onSubmit}
          className="fixed bottom-0 left-0 right-0 border-t border-slate-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/70"
        >
          <div className="mx-auto w-full max-w-sm px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={1}
              placeholder="Ask Aurora…"
              className="flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
            <button
              type="submit"
              disabled={isSending || !input.trim()}
              className={cn(
                "rounded-2xl px-4 py-3 text-sm font-semibold",
                isSending || !input.trim()
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-indigo-600 text-white hover:bg-indigo-700",
              )}
            >
              {isSending ? "…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

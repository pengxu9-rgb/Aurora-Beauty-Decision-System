"use client";

import type { SkinIdentitySnapshot } from "@/actions/userProfile";
import { getSkinIdentitySnapshot, setUserConcerns } from "@/actions/userProfile";
import { SkinIdentityCard } from "@/components/chat/SkinIdentityCard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type ClarificationQuestion = {
  id: string;
  question: string;
  options?: string[];
};

type ChatApiResponse = {
  query?: string;
  intent?: string;
  answer?: string;
  clarification?: {
    questions?: ClarificationQuestion[];
    missing_fields?: string[];
  };
  error?: string;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function makeId(prefix: string) {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  return `${prefix}_${cryptoObj?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function toApiMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
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
  const [pendingQuestionSet, setPendingQuestionSet] = useState<ClarificationQuestion[] | null>(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const selfieInputRef = useRef<HTMLInputElement | null>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [skinIdentity, setSkinIdentity] = useState<SkinIdentitySnapshot | null>(null);
  const [isIdentityLoading, setIsIdentityLoading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const lastMessageId = useMemo(() => messages[messages.length - 1]?.id ?? null, [messages]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [lastMessageId]);

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

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      setIsSending(true);
      setSendError(null);
      setPendingQuestionSet(null);

      const userMessage: ChatMessage = { id: makeId("u"), role: "user", content: trimmed };
      setMessages((prev) => {
        const next = [...prev, userMessage];
        return next;
      });
      setInput("");

      try {
        const snapshot = [...messages, userMessage].slice(-24);
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            messages: toApiMessages(snapshot),
            stream: false,
          }),
        });

        const data = (await res.json()) as ChatApiResponse;
        if (!res.ok) {
          const err = data?.error || `Request failed (${res.status})`;
          setSendError(err);
          pushMessage({ id: makeId("a"), role: "assistant", content: `Sorry — ${err}.` });
          return;
        }

        const answer = typeof data.answer === "string" && data.answer.trim() ? data.answer.trim() : "Sorry — no response.";
        pushMessage({ id: makeId("a"), role: "assistant", content: answer });

        const questions = Array.isArray(data.clarification?.questions) ? data.clarification?.questions : null;
        setPendingQuestionSet(questions?.length ? questions : null);

        if (userId) void refreshIdentity(userId);
      } catch (e) {
        const err = e instanceof Error ? e.message : "Failed to reach /api/chat";
        setSendError(err);
        pushMessage({ id: makeId("a"), role: "assistant", content: `Sorry — ${err}.` });
      } finally {
        setIsSending(false);
      }
    },
    [isSending, messages, pushMessage, refreshIdentity, userId],
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
                setPendingQuestionSet(null);
                setSendError(null);
                setInput("");
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

          {skinIdentity ? (
            <div className="mb-3">
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

          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cx(
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

          {pendingQuestionSet?.length ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-semibold text-slate-900">Quick questions (tap to answer)</div>
              <div className="mt-3 space-y-3">
                {pendingQuestionSet.map((q) => (
                  <div key={q.id}>
                    <div className="text-xs text-slate-600">{q.question}</div>
                    {Array.isArray(q.options) && q.options.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => void sendText(opt)}
                            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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
              className={cx(
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

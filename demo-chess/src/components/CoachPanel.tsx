"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CoachMarkdown } from "@/components/CoachMarkdown";
import type { PublicUser } from "@/lib/auth";
import type { ChatMessage, QuotaState } from "@/lib/types";

type Props = {
  messages: ChatMessage[];
  pending: boolean;
  user: PublicUser;
  quota: QuotaState;
  onAsk: (text: string) => Promise<void>;
};

const SUGGESTIONS = [
  "Was that a blunder?",
  "What's the plan if they castle?",
  "Which piece should I develop next?",
];

export function CoachPanel({
  messages,
  pending,
  user,
  quota,
  onAsk,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    await onAsk(text);
  };

  return (
    <aside className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--coach)] text-[#f4eee4] shadow-[0_20px_50px_rgba(26,23,20,0.18)]">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <p className="font-[family-name:var(--font-display)] text-xl">
            Coach
          </p>
          {quota.state === "exceeded" ? (
            <p
              className="text-[11px] text-[#e8a89b]"
              title={quota.detail ?? "Dome quota exhausted"}
            >
              Dome cap reached
              {quota.subject ? ` · ${quota.subject}` : ""}
            </p>
          ) : (
            <p
              className="text-[11px] text-white/45"
              title={
                quota.source === "dome"
                  ? "Spend caps are enforced by Dome per act-as subject"
                  : "Dome not configured — no spend cap enforced"
              }
            >
              {quota.source === "dome" ? "Dome quota active" : "Quota off"}
            </p>
          )}
        </div>
        <p className="text-xs text-white/55">
          Acting as {user.name} · {user.level} · tools:{" "}
          {user.tools.join(", ")}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="flex max-h-[60vh] flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {messages.map((m) =>
          m.role === "user" ? (
            <div
              key={m.id}
              className="ml-8 self-end rounded-lg rounded-br-sm bg-[var(--accent)] px-3 py-2 text-sm leading-relaxed text-white"
            >
              {m.text}
            </div>
          ) : (
            <div
              key={m.id}
              className="mr-6 rounded-lg rounded-bl-sm bg-white/[0.07] px-3.5 py-2.5"
            >
              <CoachMarkdown text={m.text} />
            </div>
          ),
        )}
        {pending ? (
          <p className="text-xs text-white/45">Coach is looking at the board…</p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-white/10 px-4 py-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending}
            onClick={() => void onAsk(s)}
            className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => void submit(e)}
        className="flex gap-2 border-t border-white/10 p-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about this position…"
          className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-white/35 focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="rounded-md bg-[var(--accent-soft)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </aside>
  );
}

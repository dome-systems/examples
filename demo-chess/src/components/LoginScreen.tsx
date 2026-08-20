"use client";

import { useState, type FormEvent } from "react";
import type { PublicUser } from "@/lib/auth";

type Props = {
  accounts: PublicUser[];
};

export function LoginScreen({ accounts }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign in failed");
        return;
      }
      window.location.reload();
    } catch {
      setError("Sign in failed — is the app API running?");
    } finally {
      setPending(false);
    }
  };

  const fill = (id: string) => {
    setUsername(id);
    setPassword(id);
    setError(null);
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 px-4 py-10 md:px-8">
      <header className="max-w-2xl">
        <p className="text-xs font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
          Dome example · interactive · delegated
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-4xl leading-none tracking-tight md:text-5xl">
          Chess Coach
        </h1>
        <p className="mt-3 text-sm text-black/70">
          Play a game and ask the coach questions mid-move. The coach acts{" "}
          <strong>as the signed-in player</strong>, so the same app answers
          differently, searches to a different depth, and enforces a different
          question budget depending on who you are.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
        <section className="grid gap-4 sm:grid-cols-2">
          {accounts.map((account) => (
            <article
              key={account.id}
              className="flex flex-col rounded-lg border border-[var(--line)] bg-white/55 p-4"
            >
              <div className="flex items-baseline justify-between">
                <h2 className="font-[family-name:var(--font-display)] text-2xl">
                  {account.name.split(" ")[0]}
                </h2>
                <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                  {account.level}
                </span>
              </div>
              <p className="mt-1 text-xs text-black/50">
                Rating {account.rating} · {account.email}
              </p>
              <p className="mt-3 text-sm text-black/75">{account.coachStyle}</p>

              <ul className="mt-3 flex flex-1 flex-col gap-1.5 text-[13px] text-black/70">
                {account.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span className="text-[var(--accent)]">·</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-3">
                <code className="text-[11px] text-black/50">
                  {account.id} / {account.id}
                </code>
                <button
                  type="button"
                  onClick={() => fill(account.id)}
                  className="rounded-md border border-[var(--line)] px-2.5 py-1 text-xs hover:bg-white"
                >
                  Use this account
                </button>
              </div>
            </article>
          ))}
        </section>

        <form
          onSubmit={(e) => void submit(e)}
          className="flex h-fit flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--coach)] p-5 text-[#f4eee4]"
        >
          <div>
            <p className="font-[family-name:var(--font-display)] text-xl">
              Sign in
            </p>
            <p className="text-xs text-white/55">
              Mock identity provider for the demo
            </p>
          </div>

          <label className="flex flex-col gap-1 text-xs text-white/65">
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="alex"
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[var(--accent-soft)]"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-white/65">
            Password
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="alex"
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[var(--accent-soft)]"
            />
          </label>

          {error ? (
            <p className="rounded-md bg-[#5b241d] px-3 py-2 text-xs text-[#ffd9d2]">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending || !username || !password}
            className="mt-1 rounded-md bg-[var(--accent-soft)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-[11px] leading-relaxed text-white/45">
            This session stands in for a verified end-user identity. Once Dome
            act-as is wired, it becomes the principal on every governed coach
            call.
          </p>
        </form>
      </div>
    </div>
  );
}

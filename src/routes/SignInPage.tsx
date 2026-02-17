import { useRef, useState } from "react";

import { useAuth } from "@/lib/auth";

export function SignInPage() {
  const { signInEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-50">
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-zinc-400">We will email you a magic link.</p>

        <div className="mt-6 flex gap-2">
          <input
            ref={inputRef}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <button
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-60"
            disabled={busy}
            onClick={async () => {
              const trimmed = email.trim();
              if (!trimmed) {
                inputRef.current?.focus();
                return;
              }
              setBusy(true);
              try {
                await signInEmail(trimmed);
                setSent(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Send link
          </button>
        </div>

        {sent ? (
          <div className="mt-4 rounded-md border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
            Sign-in link sent. Check your inbox.
          </div>
        ) : null}
      </div>
    </div>
  );
}

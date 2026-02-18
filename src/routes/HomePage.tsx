import { useMemo, useRef, useState } from "react";

import { Reader } from "@/components/reader/Reader";
import { useAuth } from "@/lib/auth";

export function HomePage() {
  const { session, status, signInEmail, signOut } = useAuth();
  const bypassAuth = import.meta.env.VITE_DEV_BYPASS_AUTH !== "0";
  const signedIn = status === "authenticated";

  const userLabel = useMemo(() => {
    if (!session?.user?.email) return "Signed in";
    return session.user.email;
  }, [session?.user?.email]);

  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-50">
      <header className="z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-baseline gap-3">
            <div className="text-sm font-semibold tracking-wide">PDF Parallel Translate Reader</div>
            <div className="hidden text-xs text-zinc-400 md:block">
              Side-by-side PDF + synced block translations
            </div>
          </div>

          <div className="flex items-center gap-2">
            {bypassAuth ? (
              <div className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
                Auth disabled
              </div>
            ) : signedIn ? (
              <>
                <div className="hidden text-xs text-zinc-400 md:block">{userLabel}</div>
                <button
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
                  onClick={async () => {
                    await signOut();
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <input
                  ref={emailRef}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="hidden w-56 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 md:block"
                />
                <button
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
                  onClick={async () => {
                    const trimmed = email.trim();
                    if (!trimmed) {
                      emailRef.current?.focus();
                      return;
                    }
                    await signInEmail(trimmed);
                    setNotice("Sign-in link sent. Check your email.");
                  }}
                >
                  Sign in (email)
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {!bypassAuth && notice ? (
        <div className="mx-auto mt-2 w-full max-w-[1400px] px-4 text-xs text-amber-300">{notice}</div>
      ) : null}

      <main className="mx-auto min-h-0 w-full max-w-[1400px] flex-1 overflow-hidden px-4 py-4">
        <Reader />
      </main>
    </div>
  );
}

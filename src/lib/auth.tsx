import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  fetchSession,
  signInEmail as authSignInEmail,
  signOut as authSignOut,
  type AppSession,
} from "@/lib/authClient";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  session: AppSession | null;
  status: AuthStatus;
  refreshSession: () => Promise<void>;
  signInEmail: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const refreshSession = useCallback(async () => {
    const next = await fetchSession().catch(() => null);
    setSession(next);
    setStatus(next?.user ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const signInEmail = useCallback(
    async (email: string) => {
      await authSignInEmail(email);
      await refreshSession();
    },
    [refreshSession],
  );

  const signOut = useCallback(async () => {
    await authSignOut();
    await refreshSession();
  }, [refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, status, refreshSession, signInEmail, signOut }),
    [session, status, refreshSession, signInEmail, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

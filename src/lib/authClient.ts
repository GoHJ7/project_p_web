export type AppSession = {
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
  };
  expires?: string;
};

async function getCsrfToken() {
  const res = await fetch("/api/auth/csrf", {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`csrf failed (${res.status})`);
  const data = (await res.json()) as { csrfToken?: string };
  if (!data.csrfToken) throw new Error("csrf token missing");
  return data.csrfToken;
}

export async function fetchSession(): Promise<AppSession | null> {
  const res = await fetch("/api/auth/session", {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as AppSession | null;
  if (!data || !data.user) return null;
  return data;
}

export async function signInEmail(email: string, callbackUrl = "/") {
  const csrfToken = await getCsrfToken();
  const body = new URLSearchParams({
    csrfToken,
    email,
    callbackUrl,
    json: "true",
  });

  const res = await fetch("/api/auth/signin/email", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`signin failed (${res.status})`);
}

export async function signOut(callbackUrl = "/") {
  const csrfToken = await getCsrfToken();
  const body = new URLSearchParams({
    csrfToken,
    callbackUrl,
    json: "true",
  });

  const res = await fetch("/api/auth/signout", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`signout failed (${res.status})`);
}

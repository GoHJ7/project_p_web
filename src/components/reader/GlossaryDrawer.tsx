"use client";

import { useEffect, useMemo, useState } from "react";

type Term = { id: string; source: string; target: string; note?: string | null };

export function GlossaryDrawer({
  open,
  onClose,
  documentId,
}: {
  open: boolean;
  onClose: () => void;
  documentId: string | null;
}) {
  const [terms, setTerms] = useState<Term[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !documentId) return;
    (async () => {
      const res = await fetch(`/api/documents/${documentId}/glossary`, {
        method: "GET",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { terms: Term[] };
      setTerms(data.terms);
    })().catch((e) => console.error("[glossary] load failed", e));
  }, [open, documentId]);

  const canAdd = useMemo(() => source.trim() && target.trim(), [source, target]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" data-testid="glossary-drawer">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="absolute right-0 top-0 h-full w-full max-w-md border-l border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-semibold">Glossary</div>
          <button
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
            data-testid="glossary-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="p-4">
          <div className="text-xs text-zinc-400">Add term</div>
          <div className="mt-2 flex gap-2">
            <input
              className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs"
              placeholder="source"
              data-testid="glossary-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <input
              className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs"
              placeholder="target"
              data-testid="glossary-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button
              className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:opacity-60"
              data-testid="glossary-add"
              disabled={!documentId || !canAdd || busy}
              onClick={async () => {
                if (!documentId) return;
                setBusy(true);
                try {
                  const res = await fetch(`/api/documents/${documentId}/glossary`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      source: source.trim(),
                      target: target.trim(),
                    }),
                  });
                  if (!res.ok) return;
                  const data = (await res.json()) as { term: Term };
                  setTerms((prev) => {
                    const m = new Map(prev.map((t) => [t.id, t]));
                    m.set(data.term.id, data.term);
                    return [...m.values()].sort((a, b) =>
                      a.source.localeCompare(b.source),
                    );
                  });
                  setSource("");
                  setTarget("");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add
            </button>
          </div>

          <div className="mt-6 text-xs text-zinc-400">Terms</div>
          <div className="mt-2 space-y-2">
            {terms.length === 0 ? (
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-500">
                No terms yet.
              </div>
            ) : (
              terms.map((t) => (
                <div
                  key={t.id}
                  className="rounded-md border border-zinc-800 bg-zinc-950 p-3"
                  data-testid="glossary-term"
                  data-source={t.source}
                  data-target={t.target}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-zinc-200">
                      {t.source} <span className="text-zinc-600">→</span>{" "}
                      {t.target}
                    </div>
                    <button
                      className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-900"
                      data-testid="glossary-delete"
                      onClick={async () => {
                        if (!documentId) return;
                        const res = await fetch(
                          `/api/documents/${documentId}/glossary`,
                          {
                            method: "DELETE",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ id: t.id }),
                          },
                        );
                        if (!res.ok) return;
                        setTerms((prev) => prev.filter((x) => x.id !== t.id));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

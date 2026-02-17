"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, set } from "idb-keyval";

import { PdfPane, type PdfPaneHandle } from "@/components/reader/PdfPane";
import {
  TranslatedPdfPane,
  type TranslatedPdfPaneHandle,
} from "@/components/reader/TranslatedPdfPane";
import { GlossaryDrawer } from "@/components/reader/GlossaryDrawer";
import { blockifyPage, type TextItem } from "@/components/reader/blockify";
import type { ClientBlock, ProviderId } from "@/components/reader/types";
import { useAuth } from "@/lib/auth";

type Extracted = {
  docKey: string;
  pageCount: number;
  pages: { pageNumber: number; width: number; height: number }[];
  blocks: ClientBlock[];
};

const DEFAULT_TRANSLATE_AHEAD = 6;

export function Reader() {
  const { status } = useAuth();
  const authed = status === "authenticated" || import.meta.env.VITE_DEV_BYPASS_AUTH === "1";

  const [provider, setProvider] = useState<ProviderId>("openai");
  const [stylePreset, setStylePreset] = useState<"default" | "formal" | "casual">(
    "default",
  );

  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");

  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<Extracted | null>(null);

  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [blocks, setBlocks] = useState<ClientBlock[]>([]);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);

  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const [translations, setTranslations] = useState<Record<string, string | undefined>>(
    {},
  );

  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const noteSaveTimers = useRef<Map<string, number>>(new Map());
  const noteLoadedFor = useRef<Set<string>>(new Set());

  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const pdfRef = useRef<PdfPaneHandle | null>(null);
  const trPdfRef = useRef<TranslatedPdfPaneHandle | null>(null);

  const handlePdfMeta = useCallback(
    (m: { docKey: string; pageCount: number }) => {
      // Keep in state even if extract failed; useful for cache keys.
      if (!extracted) return;
      if (m.docKey !== extracted.docKey) return;
    },
    [extracted],
  );

  const syncFrom = useRef<"left" | "right" | null>(null);
  const syncTimer = useRef<number | null>(null);
  const setSync = (src: "left" | "right") => {
    syncFrom.current = src;
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncFrom.current = null;
    }, 150);
  };

  const indexByAnchor = useMemo(() => {
    const m = new Map<string, number>();
    blocks.forEach((b, i) => m.set(b.anchorId, i));
    return m;
  }, [blocks]);

  const activeBlock = useMemo(() => {
    if (!activeAnchorId) return null;
    return blocks.find((b) => b.anchorId === activeAnchorId) ?? null;
  }, [activeAnchorId, blocks]);

  // Prefetch notes around the active anchor (so notes survive reload + re-upload).
  useEffect(() => {
    if (!authed) return;
    if (!activeAnchorId) return;
    if (!blocks.length) return;

    const startIndex = indexByAnchor.get(activeAnchorId) ?? 0;
    const slice = blocks.slice(startIndex, startIndex + DEFAULT_TRANSLATE_AHEAD);
    const blockIds = slice
      .map((b) => b.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const toFetch = blockIds.filter((id) => !noteLoadedFor.current.has(id));
    if (toFetch.length === 0) return;

    let cancelled = false;
    (async () => {
      const entries: Array<{ id: string; text: string | undefined }> = [];
      await Promise.all(
        toFetch.map(async (id) => {
          try {
            const res = await fetch(`/api/blocks/${id}/note`, { method: "GET" });
            if (!res.ok) return;
            const data = (await res.json().catch(() => null)) as
              | { note?: { text?: unknown } | null }
              | null;
            const text =
              typeof data?.note?.text === "string" ? (data!.note!.text as string) : undefined;
            entries.push({ id, text });
          } catch (e) {
            console.error("[note] load failed", e);
          }
        }),
      );

      if (cancelled) return;
      setNotes((prev) => {
        const next = { ...prev };
        for (const e of entries) next[e.id] = e.text;
        return next;
      });
      for (const id of toFetch) noteLoadedFor.current.add(id);
    })();

    return () => {
      cancelled = true;
    };
  }, [authed, activeAnchorId, blocks, indexByAnchor]);

  // Load cached translations for this doc+provider.
  useEffect(() => {
    if (!extracted?.docKey) return;
    (async () => {
      const key = `translations:${extracted.docKey}:${provider}`;
      const cached = (await get(key)) as Record<string, string> | undefined;
      if (cached) {
        setTranslations((prev) => ({ ...cached, ...prev }));
      }
    })().catch(() => {});
  }, [extracted?.docKey, provider]);

  const handlePickFile = async (file: File) => {
    setUploadError(null);
    setDocumentId(null);
    setExtracted(null);
    setBlocks([]);
    setActiveAnchorId(null);
    setTranslations({});
    setNotes({});
    noteLoadedFor.current.clear();

    setFileName(file.name);
    const buf = await file.arrayBuffer();
    setPdfData(buf);

    setExtracting(true);
    try {
      const result = await extractPdfBlocks(buf);
      setExtracted(result);
      setBlocks(result.blocks);
      setActiveAnchorId(result.blocks[0]?.anchorId ?? null);
    } catch (e) {
      console.error("[extract] failed", e);
      setUploadError("PDF extract failed. Make sure it is a text-based PDF.");
    } finally {
      setExtracting(false);
    }
  };

  // Upload extracted blocks to server (to enable translation + notes syncing).
  useEffect(() => {
    if (!authed) return;
    if (!extracted) return;
    if (!fileName) return;
    if (!pdfData) return;

    let cancelled = false;
    (async () => {
      setUploading(true);
      setUploadError(null);
      try {
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            docKey: extracted.docKey,
            fileName,
            pageCount: extracted.pageCount,
          }),
        });
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(msg || "create document failed");
        }
        const { documentId: docId } = (await res.json()) as { documentId: string };
        if (cancelled) return;
        setDocumentId(docId);

        // Upload by page.
        const byPage = new Map<number, ClientBlock[]>();
        for (const b of extracted.blocks) {
          const list = byPage.get(b.pageNumber) ?? [];
          list.push(b);
          byPage.set(b.pageNumber, list);
        }

        for (const p of extracted.pages) {
          const pageBlocks = byPage.get(p.pageNumber) ?? [];
          const r = await fetch(
            `/api/documents/${docId}/pages/${p.pageNumber}/blocks`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                page: { width: p.width, height: p.height },
                blocks: pageBlocks.map((b) => ({
                  anchorId: b.anchorId,
                  orderInPage: b.orderInPage,
                  globalOrder: b.globalOrder,
                  bbox: b.bbox,
                  text: b.text,
                  blockType: b.blockType,
                })),
              }),
            },
          );
          if (!r.ok) {
            const msg = await r.text();
            throw new Error(msg || `upload failed for page ${p.pageNumber}`);
          }
        }

        // Fetch canonical blocks (with IDs) so notes can be stored per-block.
        const bRes = await fetch(`/api/documents/${docId}/blocks`);
        if (!bRes.ok) throw new Error("failed to fetch blocks");
        const bData = (await bRes.json()) as {
          blocks: Array<{
            id: string;
            anchorId: string;
            pageNumber: number;
            orderInPage: number;
            globalOrder: number;
            bbox: unknown;
            text: string;
            blockType: ClientBlock["blockType"];
          }>;
        };
        const canonical: ClientBlock[] = bData.blocks.map((b) => ({
          id: b.id,
          anchorId: b.anchorId,
          pageNumber: b.pageNumber,
          orderInPage: b.orderInPage,
          globalOrder: b.globalOrder,
          bbox: b.bbox as ClientBlock["bbox"],
          text: b.text,
          blockType: b.blockType,
        }));
        if (cancelled) return;
        setBlocks(canonical);
        setActiveAnchorId((prev) => prev ?? canonical[0]?.anchorId ?? null);
      } catch (e) {
        console.error("[upload] failed", e);
        setUploadError(
          e instanceof Error ? e.message : "Upload failed (sign-in required).",
        );
      } finally {
        if (!cancelled) setUploading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authed, extracted, fileName, pdfData]);

  const translateAroundActive = async () => {
    if (!documentId) {
      setUploadError("Sign in and wait for upload to complete before translating.");
      return;
    }
    if (!activeAnchorId) return;

    const startIndex = indexByAnchor.get(activeAnchorId) ?? 0;
    const slice = blocks.slice(startIndex, startIndex + DEFAULT_TRANSLATE_AHEAD);
    const anchorIds = slice.map((b) => b.anchorId);
    if (anchorIds.length === 0) return;

    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentId,
        anchorIds,
        provider,
        targetLang: "ko",
        stylePreset,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        typeof (data as { message?: unknown }).message === "string"
          ? (data as { message: string }).message
          : undefined;
      const error =
        typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : undefined;
      setUploadError(message ?? error ?? `translate failed (${res.status})`);
      return;
    }
    const ts = (data as { translations?: unknown }).translations;
    const list: Array<{ anchorId: string; text: string }> = Array.isArray(ts)
      ? (ts as Array<{ anchorId: string; text: string }>)
      : [];
    if (list.length === 0) return;
    let nextMap: Record<string, string | undefined> = {};
    setTranslations((prev) => {
      nextMap = { ...prev };
      for (const t of list) nextMap[t.anchorId] = t.text;
      return nextMap;
    });

    if (extracted?.docKey) {
      const key = `translations:${extracted.docKey}:${provider}`;
      await set(key, nextMap);
    }
  };

  const onLeftAnchor = (anchorId: string) => {
    setActiveAnchorId(anchorId);
    if (syncFrom.current === "right") return;
    setSync("left");
    trPdfRef.current?.scrollToAnchor(anchorId);
  };

  const onRightAnchor = (anchorId: string) => {
    setActiveAnchorId(anchorId);
    if (syncFrom.current === "left") return;
    setSync("right");
    pdfRef.current?.scrollToAnchor(anchorId);
  };

  const onNoteChange = (blockId: string, text: string) => {
    setNotes((prev) => ({ ...prev, [blockId]: text }));

    const prevTimer = noteSaveTimers.current.get(blockId);
    if (prevTimer) window.clearTimeout(prevTimer);

    const t = window.setTimeout(async () => {
      try {
        await fetch(`/api/blocks/${blockId}/note`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch (e) {
        console.error("[note] save failed", e);
      }
    }, 400);
    noteSaveTimers.current.set(blockId, t);
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col gap-3"
      data-testid="reader-root"
      onDragEnter={(e) => {
        // Only activate on file drags (avoid interfering with text drags).
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);

        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        const isPdf =
          f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
          setUploadError("Please drop a PDF file.");
          return;
        }
        void handlePickFile(f);
      }}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-50 rounded-lg border-2 border-amber-400/70 bg-amber-200/10 backdrop-blur-[1px]">
          <div className="flex h-full items-center justify-center p-6">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/90 px-5 py-4 text-center">
              <div className="text-sm font-semibold text-zinc-100">Drop PDF</div>
              <div className="mt-1 text-xs text-zinc-400">
                Drop a text-based PDF to open it locally
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3">
        <label className="inline-flex items-center gap-2 text-xs text-zinc-300">
          <span className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1">
            PDF
          </span>
          <input
            type="file"
            accept="application/pdf"
            data-testid="pdf-input"
            className="text-xs text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-900"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handlePickFile(f);
            }}
          />
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs"
            data-testid="provider-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="claude">Claude</option>
          </select>
          <select
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs"
            data-testid="style-select"
            value={stylePreset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "default" || v === "formal" || v === "casual") setStylePreset(v);
            }}
          >
            <option value="default">Style: default</option>
            <option value="formal">Style: formal</option>
            <option value="casual">Style: casual</option>
          </select>

          <button
            className="rounded-md bg-amber-300 px-3 py-1.5 text-xs font-semibold text-zinc-900 disabled:opacity-60"
            data-testid="translate-button"
            disabled={!blocks.length || extracting || uploading}
            onClick={() => void translateAroundActive()}
          >
            Translate around current
          </button>

          <button
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
            data-testid="glossary-button"
            disabled={!documentId}
            onClick={() => setGlossaryOpen(true)}
          >
            Glossary
          </button>

          <button
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
            data-testid="note-button"
            disabled={!activeBlock?.id}
            onClick={() => setNoteOpen(true)}
          >
            Note
          </button>
        </div>
      </div>

      {uploadError ? (
        <div
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
          data-testid="error-banner"
        >
          {uploadError}
        </div>
      ) : null}

      <div className="grid flex-1 min-h-0 grid-cols-2 gap-3">
        <div
          className="h-full min-h-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
          onWheel={(e) => {
            // Single-scroll UX: scrolling on the left pane should move the right pane.
            trPdfRef.current?.scrollBy(e.deltaY);
          }}
        >
          <PdfPane
            ref={pdfRef}
            pdfData={pdfData}
            blocks={blocks}
            activeAnchorId={activeAnchorId}
            onUserScrollAnchorChange={onLeftAnchor}
            onPdfMeta={handlePdfMeta}
          />
        </div>
        <div
          className="h-full min-h-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
          onWheel={(e) => {
            // The right pane scrolls normally when the wheel happens inside the
            // scroller, but the header area should also scroll the right pane.
            const t = e.target as unknown as HTMLElement | null;
            if (t?.closest?.('[data-testid="tr-pdf-scroll"]')) return;
            trPdfRef.current?.scrollBy(e.deltaY);
          }}
        >
          <TranslatedPdfPane
            ref={trPdfRef}
            pdfData={pdfData}
            blocks={blocks}
            translations={translations}
            activeAnchorId={activeAnchorId}
            onUserScrollAnchorChange={onRightAnchor}
          />
        </div>
      </div>

      <GlossaryDrawer
        open={glossaryOpen}
        onClose={() => setGlossaryOpen(false)}
        documentId={documentId}
      />

      {noteOpen ? (
        <div className="fixed inset-0 z-50" data-testid="note-drawer">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setNoteOpen(false)}
          />
          <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="text-sm font-semibold text-zinc-100">Note</div>
              <button
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-900"
                onClick={() => setNoteOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="flex-1 p-4">
              <div className="text-xs text-zinc-400">
                {activeBlock?.anchorId ?? "No active block"}
              </div>
              <textarea
                className="mt-3 h-[60vh] w-full resize-none rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                placeholder={
                  activeBlock?.id
                    ? "Write a note for this anchor..."
                    : "Sign in + upload to enable notes syncing."
                }
                disabled={!activeBlock?.id}
                value={activeBlock?.id ? notes[activeBlock.id] ?? "" : ""}
                onChange={(e) => {
                  if (!activeBlock?.id) return;
                  onNoteChange(activeBlock.id, e.target.value);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function extractPdfBlocks(pdfData: ArrayBuffer): Promise<Extracted> {
  // NOTE: Use the pre-minified build to avoid dev-time bundler collisions
  // with pdfjs-dist's internal webpack runtime identifiers.
  const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
  const { GlobalWorkerOptions, getDocument, Util } = pdfjs;
  GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  // pdf.js may transfer/detach the provided ArrayBuffer when spinning up a worker.
  // Always pass a copy so the viewer can keep rendering from the original buffer.
  const loadingTask = getDocument({ data: pdfData.slice(0) });
  const pdf = await loadingTask.promise;

  const docKey = pdf.fingerprints?.[0] ?? "unknown";
  const pageCount = pdf.numPages;

  const pages: { pageNumber: number; width: number; height: number }[] = [];
  const blocks: ClientBlock[] = [];

  let globalOrder = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ pageNumber, width: viewport.width, height: viewport.height });

    const textContent = await page.getTextContent();
    const items: TextItem[] = [];
    type PdfTextItem = { str: string; transform: number[]; width: number };
    for (const raw of textContent.items ?? []) {
      const it = raw as unknown as Partial<PdfTextItem>;
      if (!it.str || !it.transform) continue;
      // Convert item transform into viewport space.
      const tx = Util.transform(viewport.transform, it.transform);
      const x = tx[4];
      const y = tx[5];
      const height = Math.hypot(tx[2], tx[3]);
      const width = Math.max(1, it.width ?? 0);
      items.push({
        str: it.str,
        x,
        y: y - height, // top
        width,
        height,
      });
    }

    const pageBlocks = blockifyPage(items, viewport.width);
    for (const b of pageBlocks) {
      const anchorId = `p${pageNumber}#b${String(b.orderInPage).padStart(3, "0")}`;
      blocks.push({
        anchorId,
        pageNumber,
        orderInPage: b.orderInPage,
        globalOrder: globalOrder++,
        bbox: b.bbox,
        text: b.text,
        blockType: b.blockType,
      });
    }
  }

  return { docKey, pageCount, pages, blocks };
}

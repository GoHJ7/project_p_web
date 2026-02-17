"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ClientBlock } from "@/components/reader/types";

export type PdfPaneHandle = {
  scrollToAnchor: (anchorId: string) => void;
  getScrollTopForAnchor: (anchorId: string) => number | null;
};

type PdfPaneProps = {
  pdfData: ArrayBuffer | null;
  blocks: ClientBlock[];
  activeAnchorId: string | null;
  onUserScrollAnchorChange: (anchorId: string) => void;
  onPdfMeta?: (meta: { docKey: string; pageCount: number }) => void;
  onExtracted?: (result: { docKey: string; pageCount: number }) => void;
};

type PageMeta = {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  offsetTop: number;
  renderedWidth: number;
  renderedHeight: number;
};

// pdfjs-dist is ESM-only. Keep imports inside the client component.
export const PdfPane = forwardRef<PdfPaneHandle, PdfPaneProps>(function PdfPane(
  { pdfData, blocks, activeAnchorId, onUserScrollAnchorChange, onPdfMeta },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [docKey, setDocKey] = useState<string>("");
  const [pageCount, setPageCount] = useState<number>(0);

  const anchorPositions = useMemo(() => {
    // Map anchorId -> absolute scrollTop within container.
    const pageByNumber = new Map(pages.map((p) => [p.pageNumber, p]));
    const out = new Map<string, number>();
    for (const b of blocks) {
      const p = pageByNumber.get(b.pageNumber);
      if (!p) continue;
      const topInPage = b.bbox.minY * p.scale;
      out.set(b.anchorId, p.offsetTop + topInPage);
    }
    return out;
  }, [blocks, pages]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToAnchor(anchorId: string) {
        const top = anchorPositions.get(anchorId);
        if (top === undefined) return;
        containerRef.current?.scrollTo({ top, behavior: "auto" });
      },
      getScrollTopForAnchor(anchorId: string) {
        const top = anchorPositions.get(anchorId);
        return top === undefined ? null : top;
      },
    }),
    [anchorPositions],
  );

  // Load + render the PDF pages.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfData || !containerRef.current) {
        setPages([]);
        setDocKey("");
        setPageCount(0);
        return;
      }

      // NOTE: Use the pre-minified build to avoid dev-time bundler collisions
      // with pdfjs-dist's internal webpack runtime identifiers.
      const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
      const { GlobalWorkerOptions, getDocument } = pdfjs;
      GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();

      // pdf.js may transfer/detach the provided ArrayBuffer when spinning up a worker.
      // Always pass a copy so other consumers (e.g., extraction) don't break.
      const loadingTask = getDocument({ data: pdfData.slice(0) });
      const pdf = await loadingTask.promise;
      if (cancelled) return;

      const fingerprint = pdf.fingerprints?.[0] ?? "unknown";
      const numPages = pdf.numPages;

      setDocKey(fingerprint);
      setPageCount(numPages);
      onPdfMeta?.({ docKey: fingerprint, pageCount: numPages });

      const containerWidth = containerRef.current.clientWidth;
      const gap = 24;

      const metas: PageMeta[] = [];
      let offsetTop = 0;

      for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport1 = page.getViewport({ scale: 1 });
        const scale = Math.max(0.2, (containerWidth - 24) / viewport1.width);
        const viewport = page.getViewport({ scale });

        metas.push({
          pageNumber,
          width: viewport1.width,
          height: viewport1.height,
          scale,
          offsetTop,
          renderedWidth: viewport.width,
          renderedHeight: viewport.height,
        });
        offsetTop += viewport.height + gap;
      }

      setPages(metas);

      // Render pages (sequential; MVP).
      for (const meta of metas) {
        const page = await pdf.getPage(meta.pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: meta.scale });
        const canvas = document.getElementById(
          `pdf-canvas-${meta.pageNumber}`,
        ) as HTMLCanvasElement | null;
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
        await renderTask.promise;
      }
    })().catch((e) => {
      console.error("[pdf] load/render failed", e);
      setPages([]);
      setDocKey("");
      setPageCount(0);
    });
    return () => {
      cancelled = true;
    };
  }, [pdfData, onPdfMeta]);

  // Scroll sync: detect current anchor based on scrollTop.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const scrollTop = el.scrollTop;
        // Find the nearest anchor whose top is <= scrollTop.
        let best: { anchorId: string; top: number } | null = null;
        for (const [anchorId, top] of anchorPositions) {
          if (top <= scrollTop + 2) {
            if (!best || top > best.top) best = { anchorId, top };
          }
        }
        const fallbackFirst = blocks[0]?.anchorId;
        const next = best?.anchorId ?? fallbackFirst ?? null;
        if (next) onUserScrollAnchorChange(next);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [anchorPositions, blocks, onUserScrollAnchorChange]);

  const activeBlock = useMemo(() => {
    if (!activeAnchorId) return null;
    return blocks.find((b) => b.anchorId === activeAnchorId) ?? null;
  }, [activeAnchorId, blocks]);

  const activeOverlay = useMemo(() => {
    if (!activeBlock) return null;
    const meta = pages.find((p) => p.pageNumber === activeBlock.pageNumber);
    if (!meta) return null;
    const left = activeBlock.bbox.minX * meta.scale;
    const top = activeBlock.bbox.minY * meta.scale;
    const width = Math.max(2, (activeBlock.bbox.maxX - activeBlock.bbox.minX) * meta.scale);
    const height = Math.max(2, (activeBlock.bbox.maxY - activeBlock.bbox.minY) * meta.scale);
    return { pageNumber: meta.pageNumber, left, top, width, height };
  }, [activeBlock, pages]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="text-xs text-zinc-400">
          {docKey ? `docKey ${docKey}` : "No PDF loaded"}
        </div>
        <div className="text-xs text-zinc-400">
          {pageCount ? `${pageCount} pages` : ""}
        </div>
      </div>

      <div
        ref={containerRef}
        className="scrollbar-none relative h-full overflow-hidden bg-zinc-900/40 px-3 py-4"
        data-testid="pdf-scroll"
      >
        {pages.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
            Select a text-based PDF to start.
          </div>
        ) : (
          <div className="mx-auto flex max-w-[920px] flex-col gap-6">
            {pages.map((p) => (
              <div
                key={p.pageNumber}
                className="relative mx-auto rounded-md bg-white shadow"
                style={{ width: Math.floor(p.renderedWidth) }}
              >
                <canvas id={`pdf-canvas-${p.pageNumber}`} />
                {activeOverlay && activeOverlay.pageNumber === p.pageNumber ? (
                  <div
                    className="pointer-events-none absolute rounded-sm border border-amber-400/70 bg-amber-300/20"
                    style={{
                      left: activeOverlay.left,
                      top: activeOverlay.top,
                      width: activeOverlay.width,
                      height: activeOverlay.height,
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

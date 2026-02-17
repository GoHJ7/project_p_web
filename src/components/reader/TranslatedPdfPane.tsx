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

export type TranslatedPdfPaneHandle = {
  scrollToAnchor: (anchorId: string) => void;
  scrollBy: (deltaY: number) => void;
};

type Props = {
  pdfData: ArrayBuffer | null;
  blocks: ClientBlock[];
  translations: Record<string, string | undefined>;
  activeAnchorId: string | null;
  onUserScrollAnchorChange: (anchorId: string) => void;
};

type PageMeta = {
  pageNumber: number;
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetTop: number;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function estimateFontSizePx(
  bboxPx: { width: number; height: number },
  text: string,
): number {
  const clean = text.replace(/\s+/g, " ").trim();
  // Start from a height-derived size, then nudge down for long text.
  const base = clamp(bboxPx.height * 0.55, 9, 18);
  const len = clean.length;
  const penalty = len > 220 ? 6 : len > 140 ? 4 : len > 80 ? 2 : 0;
  return clamp(base - penalty, 8, base);
}

// pdfjs-dist is ESM-only. Keep imports inside the client component.
export const TranslatedPdfPane = forwardRef<TranslatedPdfPaneHandle, Props>(
  function TranslatedPdfPane(
    { pdfData, blocks, translations, activeAnchorId, onUserScrollAnchorChange },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [pages, setPages] = useState<PageMeta[]>([]);
    const [docKey, setDocKey] = useState<string>("");
    const [pageCount, setPageCount] = useState<number>(0);

    const blocksByPage = useMemo(() => {
      const m = new Map<number, ClientBlock[]>();
      for (const b of blocks) {
        const list = m.get(b.pageNumber) ?? [];
        list.push(b);
        m.set(b.pageNumber, list);
      }
      for (const list of m.values()) {
        list.sort((a, b) => a.orderInPage - b.orderInPage);
      }
      return m;
    }, [blocks]);

    const anchorPositions = useMemo(() => {
      const pageByNumber = new Map(pages.map((p) => [p.pageNumber, p]));
      const out = new Map<string, number>();
      for (const b of blocks) {
        const p = pageByNumber.get(b.pageNumber);
        if (!p) continue;
        out.set(b.anchorId, p.offsetTop + b.bbox.minY * p.scale);
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
        scrollBy(deltaY: number) {
          const el = containerRef.current;
          if (!el) return;
          el.scrollTop += deltaY;
        },
      }),
      [anchorPositions],
    );

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

        const loadingTask = getDocument({ data: pdfData.slice(0) });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const fingerprint = pdf.fingerprints?.[0] ?? "unknown";
        const numPages = pdf.numPages;
        setDocKey(fingerprint);
        setPageCount(numPages);

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
            scale,
            renderedWidth: viewport.width,
            renderedHeight: viewport.height,
            offsetTop,
          });
          offsetTop += viewport.height + gap;
        }

        setPages(metas);

        // Ensure React commits canvases before we start rendering into them.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        // Render pages sequentially (MVP).
        for (const meta of metas) {
          const page = await pdf.getPage(meta.pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: meta.scale });
          let canvas = document.getElementById(
            `tr-pdf-canvas-${meta.pageNumber}`,
          ) as HTMLCanvasElement | null;
          // In fast machines, the RAF above can still race. Retry a few times.
          for (let i = 0; !canvas && i < 10; i++) {
            await new Promise((r) => setTimeout(r, 30));
            canvas = document.getElementById(
              `tr-pdf-canvas-${meta.pageNumber}`,
            ) as HTMLCanvasElement | null;
          }
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
        console.error("[tr-pdf] load/render failed", e);
        setPages([]);
        setDocKey("");
        setPageCount(0);
      });

      return () => {
        cancelled = true;
      };
    }, [pdfData]);

    // Detect current anchor based on scrollTop, report upward.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      let raf = 0;
      const onScroll = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const scrollTop = el.scrollTop;
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
      <div className="flex h-full flex-col" data-testid="tr-pdf-pane">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="text-xs text-zinc-400">
            {docKey ? `docKey ${docKey}` : "No PDF loaded"}
          </div>
          <div className="text-xs text-zinc-400">{pageCount ? `${pageCount} pages` : ""}</div>
        </div>

        <div
          ref={containerRef}
          className="relative h-full overflow-y-auto bg-zinc-900/40 px-3 py-4"
          data-testid="tr-pdf-scroll"
        >
          {pages.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
              Select a text-based PDF to start.
            </div>
          ) : (
            <div className="mx-auto flex max-w-[920px] flex-col gap-6">
              {pages.map((p) => {
                const pageBlocks = blocksByPage.get(p.pageNumber) ?? [];
                return (
                  <div
                    key={p.pageNumber}
                    className="relative mx-auto rounded-md bg-white shadow"
                    style={{ width: Math.floor(p.renderedWidth) }}
                    data-page-number={p.pageNumber}
                  >
                    <canvas id={`tr-pdf-canvas-${p.pageNumber}`} />

                    {/* Translate overlays: only for blocks that already have translations.
                        Untranslated areas remain as original text (canvas). */}
                    {pageBlocks.map((b) => {
                      const tr = translations[b.anchorId];
                      if (!tr) return null;
                      const left = b.bbox.minX * p.scale;
                      const top = b.bbox.minY * p.scale;
                      const width = Math.max(
                        2,
                        (b.bbox.maxX - b.bbox.minX) * p.scale,
                      );
                      const height = Math.max(
                        2,
                        (b.bbox.maxY - b.bbox.minY) * p.scale,
                      );

                      const fontSize = estimateFontSizePx({ width, height }, tr);

                      return (
                        <div
                          key={b.anchorId}
                          className="absolute"
                          style={{ left, top, width, height }}
                          data-anchor-id={b.anchorId}
                        >
                          <div
                            className="absolute inset-0"
                            style={{
                              background: "rgba(255,255,255,0.96)",
                            }}
                          />
                          <div
                            className="absolute inset-0 px-1 py-0.5"
                            style={{
                              fontSize,
                              lineHeight: 1.2,
                              color: "#111",
                              whiteSpace: "pre-wrap",
                              overflow: "hidden",
                              wordBreak: "break-word",
                            }}
                          >
                            {tr}
                          </div>
                        </div>
                      );
                    })}

                    {/* Active anchor highlight */}
                    {activeOverlay && activeOverlay.pageNumber === p.pageNumber ? (
                      <div
                        className="pointer-events-none absolute rounded-sm border border-amber-400/70 bg-amber-300/15"
                        style={{
                          left: activeOverlay.left,
                          top: activeOverlay.top,
                          width: activeOverlay.width,
                          height: activeOverlay.height,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  },
);

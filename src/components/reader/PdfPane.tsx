"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { blockBounds, ringToSvgPoints, scaleRingPoints } from "@/components/reader/geometry";
import { anchorStrokeColor } from "@/components/reader/mappingColor";
import type { ClientBlock, Point, ReaderRenderMode } from "@/components/reader/types";

export type PdfPaneHandle = {
  scrollToAnchor: (anchorId: string) => void;
  scrollToTop: (top: number) => void;
  getScrollTop: () => number | null;
  getScrollTopForAnchor: (anchorId: string) => number | null;
};

type PdfPaneProps = {
  pdfData: ArrayBuffer | null;
  blocks: ClientBlock[];
  activeAnchorId: string | null;
  hoverAnchorId?: string | null;
  onAnchorHoverChange?: (anchorId: string | null) => void;
  onUserScrollAnchorChange: (anchorId: string) => void;
  onPdfMeta?: (meta: { docKey: string; pageCount: number }) => void;
  onExtracted?: (result: { docKey: string; pageCount: number }) => void;
  renderMode?: ReaderRenderMode;
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

type AnchorLayout = {
  anchorId: string;
  pageNumber: number;
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  rings: Point[][];
};

export const PdfPane = forwardRef<PdfPaneHandle, PdfPaneProps>(function PdfPane(
  {
    pdfData,
    blocks,
    activeAnchorId,
    hoverAnchorId = null,
    onAnchorHoverChange,
    onUserScrollAnchorChange,
    onPdfMeta,
    renderMode = "reader",
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [docKey, setDocKey] = useState<string>("");
  const [pageCount, setPageCount] = useState<number>(0);
  const [visibleAnchorIds, setVisibleAnchorIds] = useState<string[]>([]);
  const mappingMode = renderMode === "mapping";

  const anchorLayouts = useMemo(() => {
    const pageByNumber = new Map(pages.map((p) => [p.pageNumber, p]));
    const out: AnchorLayout[] = [];
    for (const b of blocks) {
      const p = pageByNumber.get(b.pageNumber);
      if (!p) continue;
      const bounds = blockBounds(b);
      const topInPage = bounds.minY * p.scale;
      const bottomInPage = bounds.maxY * p.scale;
      const rings = b.geometry.rings.map((ring) => scaleRingPoints(ring, p.scale));
      out.push({
        anchorId: b.anchorId,
        pageNumber: b.pageNumber,
        top: p.offsetTop + topInPage,
        bottom: p.offsetTop + bottomInPage,
        left: bounds.minX * p.scale,
        width: Math.max(2, (bounds.maxX - bounds.minX) * p.scale),
        height: Math.max(2, (bounds.maxY - bounds.minY) * p.scale),
        rings,
      });
    }
    out.sort((a, b) => a.top - b.top);
    return out;
  }, [blocks, pages]);

  const anchorPositions = useMemo(
    () => new Map(anchorLayouts.map((a) => [a.anchorId, a.top])),
    [anchorLayouts],
  );

  const visibleAnchorIdSet = useMemo(
    () => new Set(visibleAnchorIds),
    [visibleAnchorIds],
  );

  const visibleOverlaysByPage = useMemo(() => {
    const out = new Map<number, AnchorLayout[]>();
    for (const layout of anchorLayouts) {
      if (!visibleAnchorIdSet.has(layout.anchorId)) continue;
      const list = out.get(layout.pageNumber) ?? [];
      list.push(layout);
      out.set(layout.pageNumber, list);
    }
    return out;
  }, [anchorLayouts, visibleAnchorIdSet]);

  const allOverlaysByPage = useMemo(() => {
    const out = new Map<number, AnchorLayout[]>();
    for (const layout of anchorLayouts) {
      const list = out.get(layout.pageNumber) ?? [];
      list.push(layout);
      out.set(layout.pageNumber, list);
    }
    return out;
  }, [anchorLayouts]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToAnchor(anchorId: string) {
        const top = anchorPositions.get(anchorId);
        if (top === undefined) return;
        containerRef.current?.scrollTo({ top, behavior: "auto" });
      },
      scrollToTop(top: number) {
        containerRef.current?.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      },
      getScrollTop() {
        return containerRef.current ? containerRef.current.scrollTop : null;
      },
      getScrollTopForAnchor(anchorId: string) {
        const top = anchorPositions.get(anchorId);
        return top === undefined ? null : top;
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

      const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
      const { GlobalWorkerOptions, getDocument } = pdfjs;
      const workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      GlobalWorkerOptions.workerSrc = `${workerSrc}?v=20260217`;

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const viewportTop = el.scrollTop;
        const viewportBottom = viewportTop + el.clientHeight;
        const viewportCenter = viewportTop + el.clientHeight / 2;

        const visible: string[] = [];
        let primary: { anchorId: string; dist: number } | null = null;

        for (const layout of anchorLayouts) {
          if (layout.bottom < viewportTop) continue;
          if (layout.top > viewportBottom) break;
          visible.push(layout.anchorId);

          const center = (layout.top + layout.bottom) / 2;
          const dist = Math.abs(center - viewportCenter);
          if (!primary || dist < primary.dist) {
            primary = { anchorId: layout.anchorId, dist };
          }
        }

        setVisibleAnchorIds((prev) => {
          if (
            prev.length === visible.length &&
            prev.every((anchorId, i) => anchorId === visible[i])
          ) {
            return prev;
          }
          return visible;
        });

        const fallbackFirst = blocks[0]?.anchorId;
        const next = primary?.anchorId ?? fallbackFirst ?? null;
        if (next) onUserScrollAnchorChange(next);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [anchorLayouts, blocks, onUserScrollAnchorChange]);

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
        className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto bg-zinc-900/40 px-3 py-4"
        data-testid="pdf-scroll"
        onMouseLeave={() => onAnchorHoverChange?.(null)}
      >
        {pages.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
            Select a PDF to start.
          </div>
        ) : (
          <div className="mx-auto flex max-w-[920px] flex-col gap-6">
            {pages.map((p) => {
              const allPageOverlays = allOverlaysByPage.get(p.pageNumber) ?? [];
              const pageHitboxes = mappingMode
                ? allPageOverlays
                : (visibleOverlaysByPage.get(p.pageNumber) ?? []);

              return (
                <div
                  key={p.pageNumber}
                  className="relative mx-auto rounded-md bg-white shadow"
                  style={{ width: Math.floor(p.renderedWidth) }}
                >
                  <canvas id={`pdf-canvas-${p.pageNumber}`} />

                  {mappingMode && allPageOverlays.length > 0 ? (
                    <svg
                      className="pointer-events-none absolute inset-0 z-[5]"
                      width={Math.floor(p.renderedWidth)}
                      height={Math.floor(p.renderedHeight)}
                    >
                      {allPageOverlays.map((overlay) => {
                        const isActive = overlay.anchorId === activeAnchorId;
                        const isHover = overlay.anchorId === hoverAnchorId;
                        const stroke = isActive
                          ? "rgba(251,191,36,0.98)"
                          : isHover
                            ? "rgba(34,211,238,0.98)"
                            : anchorStrokeColor(overlay.anchorId);
                        return overlay.rings.map((ring, i) => (
                          <polygon
                            key={`${overlay.anchorId}-${i}`}
                            points={ringToSvgPoints(ring)}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={1}
                          />
                        ));
                      })}
                    </svg>
                  ) : null}

                  {pageHitboxes.map((overlay) => {
                    const isActive = overlay.anchorId === activeAnchorId;
                    const isHover = overlay.anchorId === hoverAnchorId;
                    const interactive = mappingMode;
                    return (
                      <div
                        key={overlay.anchorId}
                        className="absolute"
                        style={{
                          left: overlay.left,
                          top: overlay.top - p.offsetTop,
                          width: overlay.width,
                          height: overlay.height,
                          pointerEvents: interactive ? "auto" : "none",
                          zIndex: 6,
                        }}
                        data-anchor-id={overlay.anchorId}
                        onMouseEnter={() => {
                          if (interactive) onAnchorHoverChange?.(overlay.anchorId);
                        }}
                        onMouseLeave={() => {
                          if (interactive) onAnchorHoverChange?.(null);
                        }}
                      >
                        {mappingMode ? (
                          <div
                            className="absolute left-0 z-10 max-w-full truncate rounded px-1.5 py-0.5 text-[10px] font-bold leading-none"
                            data-testid="anchor-badge"
                            title={overlay.anchorId}
                            style={{
                              top: -11,
                              backgroundColor: isActive
                                ? "rgba(251,191,36,0.95)"
                                : isHover
                                  ? "rgba(8,145,178,0.96)"
                                  : anchorStrokeColor(overlay.anchorId),
                              color: "#fff",
                              textShadow: "0 1px 1px rgba(0,0,0,0.55)",
                            }}
                          >
                            {overlay.anchorId}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

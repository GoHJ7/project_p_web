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

export type TranslatedPdfPaneHandle = {
  scrollToAnchor: (anchorId: string) => void;
  scrollToTop: (top: number) => void;
  scrollBy: (deltaY: number) => void;
  getScrollTop: () => number | null;
  getScrollTopForAnchor: (anchorId: string) => number | null;
};

type PageSize = {
  pageNumber: number;
  width: number;
  height: number;
};

type Props = {
  blocks: ClientBlock[];
  translations: Record<string, string | undefined>;
  translationFailures?: Record<string, string | undefined>;
  pendingAnchorIds?: Record<string, boolean>;
  activeAnchorId: string | null;
  hoverAnchorId?: string | null;
  onAnchorHoverChange?: (anchorId: string | null) => void;
  onUserScrollAnchorChange: (anchorId: string) => void;
  docKey?: string | null;
  pageCount?: number | null;
  pageSizes?: PageSize[];
  renderMode?: ReaderRenderMode;
};

type PageMeta = {
  pageNumber: number;
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetTop: number;
};

type AnchorLayout = {
  anchorId: string;
  top: number;
  bottom: number;
};

type RenderedBlock = {
  anchorId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  rings: Point[][];
  displayText: string;
  sourceText: string;
  hasFailure: boolean;
  hasTranslation: boolean;
  isPending: boolean;
  failureReason?: string;
};

const PAGE_GAP_PX = 24;
const MAX_INTER_BLOCK_GAP_PX = 24;
const MAX_GAP_COMPRESS_PX = 76;
const MIN_TRANSLATED_TEXT_WIDTH_PX = 168;
const CJK_CHAR_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function estimateCharWidthFactor(text: string): number {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) return 0.58;
  const cjkCount = (compact.match(CJK_CHAR_RE) ?? []).length;
  const cjkRatio = cjkCount / compact.length;
  return 0.58 + cjkRatio * 0.38;
}

function estimateLineCount(text: string, widthPx: number, fontSizePx: number): number {
  const compactWidth = Math.max(20, widthPx - 10);
  const widthFactor = estimateCharWidthFactor(text);
  const charsPerLine = Math.max(1, Math.floor(compactWidth / (fontSizePx * widthFactor)));
  const chunks = text.split(/\n+/);

  let lines = 0;
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
      lines += 1;
      continue;
    }
    lines += Math.max(1, Math.ceil(trimmed.length / charsPerLine));
  }
  return lines;
}

function estimateFontSizePx(
  bboxPx: { width: number; height: number },
  sourceText: string,
): number {
  const min = 8.5;
  const max = 16;
  let lo = min;
  let hi = max;
  let best = min;

  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const lines = estimateLineCount(sourceText, bboxPx.width, mid);
    const contentHeight = lines * mid * 1.2 + Math.min(8, bboxPx.height * 0.1) + 2;
    if (contentHeight <= bboxPx.height + 1) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return clamp(best * 1.05, min, max);
}

function estimateTextHeightPx(
  bboxPx: { width: number; height: number },
  text: string,
  fontSizePx: number,
): number {
  const lines = estimateLineCount(text, bboxPx.width, fontSizePx);
  const lineHeight = fontSizePx * 1.23;
  const topPadding = Math.min(12, bboxPx.height * 0.16);
  const bottomPadding = 6;
  return Math.ceil(lines * lineHeight + topPadding + bottomPadding + 2);
}

function waitingText(isPending: boolean): string {
  return isPending ? "Translating..." : "Waiting for translation...";
}

export const TranslatedPdfPane = forwardRef<TranslatedPdfPaneHandle, Props>(
  function TranslatedPdfPane(
    {
      blocks,
      translations,
      translationFailures = {},
      pendingAnchorIds = {},
      activeAnchorId,
      hoverAnchorId = null,
      onAnchorHoverChange,
      onUserScrollAnchorChange,
      docKey,
      pageCount,
      pageSizes = [],
      renderMode = "reader",
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [measuredTextHeights, setMeasuredTextHeights] = useState<
      Record<string, number>
    >({});
    const mappingMode = renderMode === "mapping";
    const compareMode = renderMode === "compare";
    const strictMappingLayout = renderMode === "mapping";

    const blocksByPage = useMemo(() => {
      const m = new Map<number, ClientBlock[]>();
      for (const b of blocks) {
        const list = m.get(b.pageNumber) ?? [];
        list.push(b);
        m.set(b.pageNumber, list);
      }
      for (const list of m.values()) {
        list.sort((a, b) => {
          const ab = blockBounds(a);
          const bb = blockBounds(b);
          return ab.minY - bb.minY || ab.minX - bb.minX || a.orderInPage - b.orderInPage;
        });
      }
      return m;
    }, [blocks]);

    const { pages, renderedBlocksByPage, anchorLayouts } = useMemo(() => {
      if (pageSizes.length === 0 || containerWidth === 0) {
        return {
          pages: [] as PageMeta[],
          renderedBlocksByPage: new Map<number, RenderedBlock[]>(),
          anchorLayouts: [] as AnchorLayout[],
        };
      }

      const pageMetas: PageMeta[] = [];
      const blockMap = new Map<number, RenderedBlock[]>();
      const anchors: AnchorLayout[] = [];
      let offsetTop = 0;

      for (const ps of pageSizes) {
        const scale = Math.max(0.2, (containerWidth - 24) / ps.width);
        const renderedWidth = ps.width * scale;
        const baseRenderedHeight = ps.height * scale;
        const sourceBlocks = blocksByPage.get(ps.pageNumber) ?? [];

        const renderedBlocks: RenderedBlock[] = [];
        let cursorBottom = 0;
        let prevBaseBottom = 0;

        for (const b of sourceBlocks) {
          const bounds = blockBounds(b);
          const left = bounds.minX * scale;
          const baseTop = bounds.minY * scale;
          const sourceWidth = Math.max(2, (bounds.maxX - bounds.minX) * scale);
          const baseHeight = Math.max(2, (bounds.maxY - bounds.minY) * scale);
          if (sourceWidth < 2 || baseHeight < 2) continue;

          const tr = translations[b.anchorId];
          const failureReason = translationFailures[b.anchorId];
          const hasFailure =
            typeof failureReason === "string" && failureReason.trim().length > 0;
          const hasTranslation =
            !hasFailure && typeof tr === "string" && tr.trim().length > 0;
          const isPending = Boolean(pendingAnchorIds[b.anchorId]);

          const maxWidthForBlock = Math.max(2, renderedWidth - left - 2);
          const widenForReadability =
            !strictMappingLayout &&
            b.blockType === "TEXT" &&
            (hasTranslation || hasFailure) &&
            sourceWidth < MIN_TRANSLATED_TEXT_WIDTH_PX;
          const width = widenForReadability
            ? Math.min(maxWidthForBlock, Math.max(sourceWidth, MIN_TRANSLATED_TEXT_WIDTH_PX))
            : sourceWidth;

          let displayText = b.text;
          if (hasFailure) {
            displayText = `Translation failed\n${failureReason ?? ""}`.trim();
          } else if (hasTranslation) {
            displayText = tr!;
          } else if (renderMode === "reader") {
            displayText = waitingText(isPending);
          }

          const fontSize = estimateFontSizePx({ width, height: baseHeight }, b.text);
          const estimatedHeight = estimateTextHeightPx(
            { width, height: baseHeight },
            displayText,
            fontSize,
          );
          const measuredHeight = measuredTextHeights[b.anchorId] ?? 0;
          const minHeight = Math.max(16, fontSize * 1.55);
          let targetHeight = baseHeight;
          if (!strictMappingLayout && (hasTranslation || hasFailure || renderMode === "reader")) {
            targetHeight = Math.max(baseHeight, estimatedHeight, measuredHeight, minHeight);
          }
          if (!strictMappingLayout && isPending && !hasTranslation && !hasFailure) {
            targetHeight = Math.max(minHeight, Math.min(targetHeight, baseHeight * 1.2));
          }

          const baseGap = Math.max(0, baseTop - prevBaseBottom);
          const boundedGap = clamp(baseGap, 2, MAX_INTER_BLOCK_GAP_PX);
          const minTopByFlow = cursorBottom + boundedGap;
          const minTopByAnchor = Math.max(0, baseTop - MAX_GAP_COMPRESS_PX);
          const top = strictMappingLayout ? baseTop : Math.max(minTopByFlow, minTopByAnchor);
          const height = strictMappingLayout ? baseHeight : targetHeight;
          const bottom = top + height;

          renderedBlocks.push({
            anchorId: b.anchorId,
            left,
            top,
            width,
            height,
            fontSize,
            rings: b.geometry.rings.map((ring) => scaleRingPoints(ring, scale)),
            displayText,
            sourceText: b.text,
            hasFailure,
            hasTranslation,
            isPending,
            failureReason: hasFailure ? failureReason : undefined,
          });

          anchors.push({
            anchorId: b.anchorId,
            top: offsetTop + top,
            bottom: offsetTop + bottom,
          });

          cursorBottom = strictMappingLayout ? Math.max(cursorBottom, bottom) : bottom;
          prevBaseBottom = baseTop + baseHeight;
        }

        const renderedHeight = strictMappingLayout
          ? baseRenderedHeight
          : Math.max(baseRenderedHeight, cursorBottom + 4);
        pageMetas.push({
          pageNumber: ps.pageNumber,
          scale,
          renderedWidth,
          renderedHeight,
          offsetTop,
        });
        blockMap.set(ps.pageNumber, renderedBlocks);
        offsetTop += renderedHeight + PAGE_GAP_PX;
      }

      anchors.sort((a, b) => a.top - b.top);
      return {
        pages: pageMetas,
        renderedBlocksByPage: blockMap,
        anchorLayouts: anchors,
      };
    }, [
      blocksByPage,
      containerWidth,
      measuredTextHeights,
      pageSizes,
      pendingAnchorIds,
      renderMode,
      strictMappingLayout,
      translationFailures,
      translations,
    ]);

    const anchorPositions = useMemo(
      () => new Map(anchorLayouts.map((a) => [a.anchorId, a.top])),
      [anchorLayouts],
    );

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
        scrollBy(deltaY: number) {
          const el = containerRef.current;
          if (!el) return;
          el.scrollTop += deltaY;
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
      const el = containerRef.current;
      if (!el) return;
      const update = () => setContainerWidth(el.clientWidth);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    useEffect(() => {
      setMeasuredTextHeights({});
    }, [docKey, pageSizes.length, renderMode]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el || pages.length === 0) return;

      const raf = requestAnimationFrame(() => {
        const observed: Record<string, number> = {};
        el.querySelectorAll<HTMLElement>("[data-anchor-id]").forEach((blockEl) => {
          const anchorId = blockEl.dataset.anchorId;
          if (!anchorId) return;
          const textEl = blockEl.querySelector<HTMLElement>(
            "[data-role='translated-block-text']",
          );
          if (!textEl) return;
          const needed = Math.ceil(textEl.getBoundingClientRect().height + 2);
          if (needed <= 0) return;
          observed[anchorId] = needed;
        });

        if (Object.keys(observed).length === 0) return;
        setMeasuredTextHeights((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [anchorId, needed] of Object.entries(observed)) {
            const prevHeight = next[anchorId] ?? 0;
            if (Math.abs(prevHeight - needed) >= 2) {
              next[anchorId] = needed;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      });

      return () => cancelAnimationFrame(raf);
    }, [pages, renderedBlocksByPage, translations, translationFailures, renderMode]);

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

          let primary: { anchorId: string; dist: number } | null = null;
          for (const layout of anchorLayouts) {
            if (layout.bottom < viewportTop) continue;
            if (layout.top > viewportBottom) break;
            const center = (layout.top + layout.bottom) / 2;
            const dist = Math.abs(center - viewportCenter);
            if (!primary || dist < primary.dist) primary = { anchorId: layout.anchorId, dist };
          }

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

    const displayDocKey = docKey || "";
    const displayPageCount = pageCount || 0;

    return (
      <div className="flex h-full flex-col" data-testid="tr-pdf-pane">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="text-xs text-zinc-400">
            {displayDocKey ? `docKey ${displayDocKey}` : "No PDF loaded"}
          </div>
          <div className="text-xs text-zinc-400">
            {displayPageCount ? `${displayPageCount} pages` : ""}
          </div>
        </div>

        <div
          ref={containerRef}
          className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto bg-zinc-900/40 px-3 py-4"
          data-testid="tr-pdf-scroll"
          onMouseLeave={() => onAnchorHoverChange?.(null)}
        >
          {pages.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
              {pageSizes.length === 0 ? "Select a PDF to start." : "Measuring layout..."}
            </div>
          ) : (
            <div className="mx-auto flex max-w-[920px] flex-col gap-6">
              {pages.map((p) => {
                const pageBlocks = renderedBlocksByPage.get(p.pageNumber) ?? [];
                return (
                  <div
                    key={p.pageNumber}
                    className="relative mx-auto rounded-md bg-white shadow"
                    style={{ width: Math.floor(p.renderedWidth) }}
                    data-page-number={p.pageNumber}
                  >
                    <div
                      aria-hidden="true"
                      className="w-full bg-white"
                      style={{ height: Math.floor(p.renderedHeight) }}
                    />

                    {mappingMode ? (
                      <svg
                        className="pointer-events-none absolute inset-0 z-[5]"
                        width={Math.floor(p.renderedWidth)}
                        height={Math.floor(p.renderedHeight)}
                      >
                        {pageBlocks.map((b) => {
                          const isActive = b.anchorId === activeAnchorId;
                          const isHover = b.anchorId === hoverAnchorId;
                          const stroke = isActive
                            ? "rgba(251,191,36,0.98)"
                            : isHover
                              ? "rgba(34,211,238,0.98)"
                              : anchorStrokeColor(b.anchorId);
                          return b.rings.map((ring, i) => (
                            <polygon
                              key={`${b.anchorId}-${i}`}
                              points={ringToSvgPoints(ring)}
                              fill="none"
                              stroke={stroke}
                              strokeWidth={1}
                            />
                          ));
                        })}
                      </svg>
                    ) : null}

                    {pageBlocks.map((b) => {
                      const isActive = b.anchorId === activeAnchorId;
                      const isHover = b.anchorId === hoverAnchorId;
                      const borderColor = isActive
                        ? "border-amber-400"
                        : isHover
                          ? "border-cyan-400"
                          : b.isPending && !b.hasTranslation
                            ? "border-amber-400/70"
                            : b.hasFailure
                              ? "border-rose-400/75"
                              : b.hasTranslation
                                ? "border-sky-400/55"
                                : "border-zinc-300/40";

                      const className = mappingMode
                        ? "absolute cursor-default overflow-visible"
                        : `absolute cursor-default overflow-hidden rounded-sm border ${borderColor}`;

                      return (
                        <div
                          key={b.anchorId}
                          className={className}
                          style={{
                            left: b.left,
                            top: b.top,
                            width: b.width,
                            height: b.height,
                            backgroundColor: mappingMode
                              ? "transparent"
                              : isActive
                                ? "rgba(253,224,71,0.2)"
                                : isHover
                                  ? "rgba(34,211,238,0.12)"
                                  : b.isPending
                                    ? "rgba(253,224,71,0.13)"
                                    : b.hasFailure
                                      ? "rgba(251,113,133,0.1)"
                                      : "transparent",
                            borderColor: mappingMode ? "transparent" : undefined,
                            boxShadow: !mappingMode && compareMode
                              ? `inset 2px 0 0 ${
                                  isHover ? "rgba(34,211,238,0.95)" : anchorStrokeColor(b.anchorId)
                                }`
                              : undefined,
                            zIndex: 6,
                          }}
                          data-anchor-id={b.anchorId}
                          onMouseEnter={() => {
                            if (mappingMode) onAnchorHoverChange?.(b.anchorId);
                          }}
                          onMouseLeave={() => {
                            if (mappingMode) onAnchorHoverChange?.(null);
                          }}
                        >
                          {(mappingMode || compareMode) ? (
                            <div
                              className="absolute left-0 z-10 max-w-full truncate rounded px-0.5 text-[9px] font-mono leading-none"
                              style={{
                                top: mappingMode ? -11 : 0,
                                backgroundColor: isActive
                                  ? "rgba(251,191,36,0.9)"
                                  : isHover
                                    ? "rgba(8,145,178,0.95)"
                                    : anchorStrokeColor(b.anchorId),
                                color: "#fff",
                              }}
                              title={
                                b.hasFailure && b.failureReason
                                  ? `${b.anchorId} • ${b.failureReason}`
                                  : b.anchorId
                              }
                            >
                              {b.anchorId}
                            </div>
                          ) : null}

                          {b.hasFailure ? (
                            <div
                              className="absolute right-0 z-10 rounded bg-rose-500 px-1 text-[9px] font-semibold leading-none text-white"
                              style={{ top: mappingMode ? -11 : 0 }}
                            >
                              FAIL
                            </div>
                          ) : null}

                          {b.isPending && !b.hasTranslation ? (
                            <div
                              className="absolute right-0 z-10 rounded bg-amber-500 px-1 text-[9px] font-semibold leading-none text-zinc-900"
                              style={{ top: mappingMode ? -11 : 0 }}
                            >
                              PENDING
                            </div>
                          ) : null}

                          {compareMode && b.hasTranslation ? (
                            <div
                              className="absolute left-0 right-0 top-0 px-2"
                              style={{
                                paddingTop: Math.min(11, b.height * 0.12),
                                color: "rgba(63,63,70,0.33)",
                                fontSize: Math.max(8, b.fontSize * 0.86),
                                lineHeight: 1.2,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                overflowWrap: "anywhere",
                                userSelect: "none",
                              }}
                              aria-hidden="true"
                            >
                              {b.sourceText}
                            </div>
                          ) : null}

                          <div
                            className="absolute left-0 right-0 top-0 px-2"
                            data-role="translated-block-text"
                            style={{
                              paddingTop: Math.min(12, b.height * 0.14),
                              paddingBottom: 4,
                              fontSize: b.fontSize,
                              lineHeight: 1.22,
                              fontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
                              color: b.hasFailure
                                ? "#9f1239"
                                : b.hasTranslation
                                  ? "#111"
                                  : renderMode === "reader"
                                    ? "#71717a"
                                    : "#555",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {b.displayText}
                          </div>
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
  },
);

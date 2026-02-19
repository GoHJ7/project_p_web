"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { blockBounds, scaleRingPoints } from "@/components/reader/geometry";
import { anchorStrokeColor } from "@/components/reader/mappingColor";
import type {
  ClientBlock,
  ClientImageUnit,
  Point,
  ReaderRenderMode,
} from "@/components/reader/types";

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
  pdfData?: ArrayBuffer | null;
  blocks: ClientBlock[];
  imageUnits?: ClientImageUnit[];
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
  continuesFromPrevPage?: boolean;
  continuesToNextPage?: boolean;
};

type FlowSegment = {
  anchorId: string;
  text: string;
  fontSize: number;
  sourceWidthRatio: number;
  sourceIndentRatio: number;
  sourceLineEstimate: number;
  blockType: ClientBlock["blockType"];
  hasFailure: boolean;
  hasTranslation: boolean;
  isPending: boolean;
  failureReason?: string;
  continuesFromPrevPage?: boolean;
  continuesToNextPage?: boolean;
};

type ParagraphKind = "body" | "heading" | "toc" | "list" | "codeMath";

type FlowParagraph = {
  id: string;
  segments: FlowSegment[];
  kind: ParagraphKind;
  targetLineCount: number;
  baseWidthRatio: number;
  baseIndentRatio: number;
  gapBeforePx: number;
  sourceTopPx: number;
  sourceLeftRatio: number;
};

const PAGE_GAP_PX = 24;
const MAX_INTER_BLOCK_GAP_PX = 24;
const MAX_GAP_COMPRESS_PX = 76;
const MIN_TRANSLATED_TEXT_WIDTH_PX = 168;
const MIN_TRANSLATED_TEXT_WIDTH_RATIO = 0.54;
const PAGE_TEXT_INSET_MIN_PX = 10;
const PAGE_TEXT_INSET_MAX_PX = 24;
const FLOW_LINE_GAP_PX = 4;
const FLOW_PARAGRAPH_GAP_PX = 12;
const FLOW_PARAGRAPH_GAP_MAX_PX = 64;
const CJK_CHAR_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
const CJK_CHAR_DETECT_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const SENTENCE_END_RE = /[.!?。！？…]["')\]»”’]*\s*$/;
const LIST_OR_HEADING_START_RE = /^\s*(?:[-*•▪◦]|\d+[.)]|[IVX]+\.)\s+/;
const LEADING_PUNCT_RE = /^[,.;:!?)]/;
const LIST_START_RE = /^\s*(?:[-*•▪◦]|\d+[.)]|[A-Za-z][.)]|[IVXLC]+\.)\s+/;
const HEADING_HINT_RE =
  /^(?:chapter|contents|preface|introduction|acknowledg?ments?|bibliography|index|notes?|about|appendix|차례|머리말|서문|감사의 글|참고문헌|색인|저자 소개)\b/i;
const HEADING_ALL_CAPS_RE = /^[A-Z0-9][A-Z0-9\s:;,'".&/-]{3,}$/;
const TOC_HINT_RE =
  /\b(?:chapter|contents|preface|acknowledg?ments?|bibliography|index|notes?|about the authors|차례|목차|저자 소개)\b/i;
const TOC_DOT_LEADER_RE = /\.\.+\s*\d{1,4}\s*$/;
const TOC_TRAILING_PAGE_RE = /\b\d{1,4}\s*$/;
const TITLE_CASE_MULTI_WORD_RE = /^[A-Z0-9][A-Za-z0-9'&./-]*(?:\s+[A-Z0-9][A-Za-z0-9'&./-]*)+$/;

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clamp(parsed, min, max));
}

const FLOW_PARAGRAPH_MIN_WIDTH_RATIO = envNumber(
  "VITE_FLOW_PARAGRAPH_MIN_WIDTH_RATIO",
  0.58,
  0.4,
  0.92,
);
const FLOW_PARAGRAPH_MAX_WIDTH_RATIO = envNumber(
  "VITE_FLOW_PARAGRAPH_MAX_WIDTH_RATIO",
  1,
  FLOW_PARAGRAPH_MIN_WIDTH_RATIO,
  1,
);
const FLOW_PARAGRAPH_MAX_INDENT_RATIO = envNumber(
  "VITE_FLOW_PARAGRAPH_MAX_INDENT_RATIO",
  0.18,
  0,
  0.3,
);
const FLOW_WIDTH_TUNE_MIN = envNumber("VITE_FLOW_WIDTH_TUNE_MIN", -0.14, -0.35, 0);
const FLOW_WIDTH_TUNE_MAX = envNumber("VITE_FLOW_WIDTH_TUNE_MAX", 0.2, 0, 0.45);
const FLOW_WIDTH_TUNE_PASS_LIMIT = envInt("VITE_FLOW_WIDTH_TUNE_PASS_LIMIT", 2, 0, 4);
const FLOW_WIDTH_TUNE_THRESHOLD_LINES = envInt(
  "VITE_FLOW_WIDTH_TUNE_THRESHOLD_LINES",
  2,
  1,
  6,
);
const FLOW_WIDTH_TUNE_STEP = envNumber("VITE_FLOW_WIDTH_TUNE_STEP", 0.045, 0.01, 0.2);
const FLOW_WIDTH_TUNE_STEP_LARGE = envNumber(
  "VITE_FLOW_WIDTH_TUNE_STEP_LARGE",
  0.065,
  FLOW_WIDTH_TUNE_STEP,
  0.3,
);
const FLOW_START_ANCHOR_GAP_WEIGHT = envNumber(
  "VITE_FLOW_START_ANCHOR_GAP_WEIGHT",
  0.72,
  0,
  1,
);
const FLOW_FIRST_PARAGRAPH_TOP_WEIGHT = envNumber(
  "VITE_FLOW_FIRST_PARAGRAPH_TOP_WEIGHT",
  0.84,
  0,
  1.5,
);
const FLOW_FIRST_PARAGRAPH_TOP_MAX_PX = envNumber(
  "VITE_FLOW_FIRST_PARAGRAPH_TOP_MAX_PX",
  240,
  0,
  420,
);
const FLOW_PARAGRAPH_HEADING_MAX_INDENT_RATIO = envNumber(
  "VITE_FLOW_PARAGRAPH_HEADING_MAX_INDENT_RATIO",
  0.62,
  0,
  0.8,
);

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

function hasCjkCharacters(text: string): boolean {
  return CJK_CHAR_DETECT_RE.test(text);
}

function endsLikeSentence(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return SENTENCE_END_RE.test(trimmed);
}

function shouldMarkPageContinuation(prevText: string, nextText: string): boolean {
  const prev = prevText.trim();
  const next = nextText.trim();
  if (prev.length < 8 || next.length === 0) return false;
  if (endsLikeSentence(prev)) return false;
  if (LIST_OR_HEADING_START_RE.test(next)) return false;
  return true;
}

function joinerForFlow(prevText: string, nextText: string): string {
  if (prevText.length === 0 || nextText.length === 0) return "";
  if (/\s$/.test(prevText) || /^\s/.test(nextText)) return "";
  if (prevText.endsWith("-")) return "";
  if (LEADING_PUNCT_RE.test(nextText)) return "";
  return " ";
}

function looksStandaloneMetaLine(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(t)) return true;
  // Copyright header lines are frequently single-line meta blocks that should
  // not be merged with following body paragraphs.
  if (/\bcopyright\b/i.test(t) && /(?:©|\(c\)|\b\d{4}\b)/i.test(t)) return true;

  const words = t.split(/\s+/).filter(Boolean);
  const hasSentenceEnd = endsLikeSentence(t);
  if (hasSentenceEnd) return false;

  if (words.length <= 5 && t.length <= 40) return true;
  if (words.length <= 8 && TITLE_CASE_MULTI_WORD_RE.test(t) && t.length <= 88) return true;

  if (hasCjkCharacters(t) && !/[.!?。！？]/.test(t) && t.length <= 24) return true;
  return false;
}

function shouldForceParagraphBreakByBoundary(params: {
  prevText: string;
  nextText: string;
  prevSourceWidth: number;
  sourceWidth: number;
  readableWidth: number;
  baseGap: number;
}): boolean {
  const prev = params.prevText.trim();
  const next = params.nextText.trim();
  if (prev.length === 0 || next.length === 0) return false;
  const prevLooksStandalone = looksStandaloneMetaLine(prev);
  const nextLooksStandalone = looksStandaloneMetaLine(next);

  // Meta/header line followed by body-like text should start a new paragraph
  // even when the previous line does not end with sentence punctuation.
  if (prevLooksStandalone && !nextLooksStandalone) {
    const nextLooksBodyLike =
      next.length >= 28 ||
      /[.!?。！？]/.test(next) ||
      /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,}/.test(next);
    if (nextLooksBodyLike) return true;
  }

  if (!endsLikeSentence(prev)) return false;

  const nextLooksStandaloneAfterSentence =
    nextLooksStandalone ||
    LIST_OR_HEADING_START_RE.test(next) ||
    TOC_DOT_LEADER_RE.test(next) ||
    TOC_TRAILING_PAGE_RE.test(next);

  const widthDropBreak =
    params.prevSourceWidth > 0 &&
    params.sourceWidth <= params.prevSourceWidth * 0.72 &&
    params.sourceWidth <= params.readableWidth * 0.78 &&
    next.length <= 96;

  const gapBreak = params.baseGap >= FLOW_LINE_GAP_PX + 1;

  return nextLooksStandaloneAfterSentence || widthDropBreak || gapBreak;
}

function classifyParagraphKind(text: string, segments: FlowSegment[]): ParagraphKind {
  if (segments.some((seg) => seg.blockType !== "TEXT")) return "codeMath";
  const trimmed = text.trim();
  if (trimmed.length === 0) return "body";

  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "body";
  const shortLineCount = lines.filter((line) => line.length <= 64).length;
  const listLikeCount = lines.filter((line) => LIST_START_RE.test(line)).length;
  const dotLeaderCount = lines.filter((line) => TOC_DOT_LEADER_RE.test(line)).length;
  const trailingPageNumCount = lines.filter((line) => TOC_TRAILING_PAGE_RE.test(line)).length;
  const headingLikeCount = lines.filter(
    (line) =>
      HEADING_HINT_RE.test(line) ||
      (line.length <= 88 && HEADING_ALL_CAPS_RE.test(line.toUpperCase())),
  ).length;
  const tocLikeCount = lines.filter((line) => TOC_HINT_RE.test(line)).length;
  const lineAvgLength = trimmed.length / Math.max(1, lines.length);
  const mostlyShortLines = shortLineCount >= Math.ceil(lines.length * 0.75);
  const tocNumericSignature =
    dotLeaderCount >= 1 ||
    trailingPageNumCount >= Math.max(2, Math.ceil(lines.length * 0.4));

  if (listLikeCount >= Math.max(1, Math.ceil(lines.length * 0.5))) return "list";
  if (
    lines.length >= 3 &&
    mostlyShortLines &&
    lineAvgLength <= 74 &&
    (tocLikeCount > 0 || headingLikeCount > 0 || tocNumericSignature)
  ) {
    return "toc";
  }
  if (
    lines.length <= 2 &&
    shortLineCount === lines.length &&
    !tocNumericSignature &&
    (headingLikeCount > 0 || HEADING_HINT_RE.test(trimmed))
  ) {
    return "heading";
  }
  return "body";
}

function widthRatioByKind(base: number, kind: ParagraphKind): number {
  if (kind === "heading") return clamp(base * 1.02, 0.24, 0.9);
  if (kind === "toc") return clamp(base * 0.97 + 0.02, 0.62, 0.96);
  if (kind === "list") return clamp(base * 0.98, 0.72, 0.98);
  if (kind === "codeMath") return clamp(base * 0.96, 0.7, 0.98);
  return clamp(base, 0.66, 1);
}

function paragraphGapByKind(gapPx: number, kind: ParagraphKind): number {
  if (kind === "heading") return clamp(gapPx + 8, FLOW_PARAGRAPH_GAP_PX, FLOW_PARAGRAPH_GAP_MAX_PX);
  if (kind === "toc") return clamp(gapPx + 2, FLOW_PARAGRAPH_GAP_PX, FLOW_PARAGRAPH_GAP_MAX_PX);
  return clamp(gapPx, FLOW_PARAGRAPH_GAP_PX, FLOW_PARAGRAPH_GAP_MAX_PX);
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
      pdfData = null,
      blocks,
      imageUnits = [],
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
    const [measuredFlowAnchors, setMeasuredFlowAnchors] = useState<AnchorLayout[]>([]);
    const [paragraphWidthTuning, setParagraphWidthTuning] = useState<Record<string, number>>(
      {},
    );
    const [paragraphTunePass, setParagraphTunePass] = useState(0);
    const mappingMode = renderMode === "mapping";
    const strictMappingLayout = false;

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

    const pagesWithImages = useMemo(() => {
      const out = new Set<number>();
      for (const unit of imageUnits) {
        if (unit.kind !== "IMAGE") continue;
        out.add(unit.pageNumber);
      }
      return out;
    }, [imageUnits]);

    const { pages, renderedBlocksByPage, flowParagraphsByPage, anchorLayouts } = useMemo(() => {
      if (pageSizes.length === 0 || containerWidth === 0) {
        return {
          pages: [] as PageMeta[],
          renderedBlocksByPage: new Map<number, RenderedBlock[]>(),
          flowParagraphsByPage: new Map<number, FlowParagraph[]>(),
          anchorLayouts: [] as AnchorLayout[],
        };
      }

      const pageMetas: PageMeta[] = [];
      const blockMap = new Map<number, RenderedBlock[]>();
      const flowParagraphMap = new Map<number, FlowParagraph[]>();
      const flowSegmentByAnchor = new Map<string, FlowSegment>();
      const anchors: AnchorLayout[] = [];
      let offsetTop = 0;

      for (const ps of pageSizes) {
        const scale = Math.max(0.2, (containerWidth - 24) / ps.width);
        const renderedWidth = ps.width * scale;
        const baseRenderedHeight = ps.height * scale;
        const sourceBlocks = blocksByPage.get(ps.pageNumber) ?? [];

        const renderedBlocks: RenderedBlock[] = [];
        const flowParagraphs: FlowParagraph[] = [];
        let currentParagraph: FlowParagraph | null = null;
        const openParagraph = (
          anchorId: string,
          gapBeforePx: number,
          sourceTopPx: number,
          sourceLeftRatio: number,
        ): FlowParagraph => {
          const next: FlowParagraph = {
            id: `${ps.pageNumber}-${anchorId}`,
            segments: [],
            kind: "body",
            targetLineCount: 0,
            baseWidthRatio: 0,
            baseIndentRatio: 0,
            gapBeforePx,
            sourceTopPx,
            sourceLeftRatio,
          };
          flowParagraphs.push(next);
          return next;
        };
        let cursorBottom = 0;
        let prevBaseBottom = 0;
        let prevBlockType: ClientBlock["blockType"] | null = null;
        let prevSourceText = "";
        let prevSourceWidth = 0;

        for (const b of sourceBlocks) {
          const bounds = blockBounds(b);
          const baseLeft = bounds.minX * scale;
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

          const pageTextInset = clamp(
            renderedWidth * 0.03,
            PAGE_TEXT_INSET_MIN_PX,
            PAGE_TEXT_INSET_MAX_PX,
          );
          const maxReadableWidth = Math.max(2, renderedWidth - pageTextInset * 2);
          const shouldPreferReadableWidth =
            !strictMappingLayout &&
            b.blockType === "TEXT" &&
            (hasTranslation || hasFailure || renderMode === "reader");

          let left = baseLeft;
          let width = Math.min(sourceWidth, Math.max(2, renderedWidth - left - 2));
          if (!strictMappingLayout) {
            left = pageTextInset;
            width = maxReadableWidth;
          } else if (shouldPreferReadableWidth) {
            const minReadableWidth = Math.max(
              MIN_TRANSLATED_TEXT_WIDTH_PX,
              maxReadableWidth * MIN_TRANSLATED_TEXT_WIDTH_RATIO,
            );
            width = Math.min(maxReadableWidth, Math.max(sourceWidth, minReadableWidth));
            if (renderMode === "reader") {
              left = pageTextInset;
            } else {
              left = clamp(
                baseLeft,
                pageTextInset,
                Math.max(pageTextInset, renderedWidth - pageTextInset - width),
              );
            }
          }
          width = Math.min(width, Math.max(2, renderedWidth - left - 2));

          let displayText = b.text;
          if (hasFailure) {
            displayText = `Translation failed\n${failureReason ?? ""}`.trim();
          } else if (hasTranslation) {
            displayText = tr!;
          } else if (renderMode === "reader") {
            displayText = waitingText(isPending);
          }

          const fontSizingText = hasTranslation || hasFailure ? displayText : b.text;
          const fontSize = estimateFontSizePx({ width, height: baseHeight }, fontSizingText);
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
          const paragraphGap = Math.max(
            FLOW_PARAGRAPH_GAP_PX,
            Math.min(MAX_GAP_COMPRESS_PX, boundedGap),
          );
          const semanticBoundaryBreak =
            prevBlockType !== null &&
            shouldForceParagraphBreakByBoundary({
              prevText: prevSourceText,
              nextText: b.text,
              prevSourceWidth,
              sourceWidth,
              readableWidth: maxReadableWidth,
              baseGap,
            });
          const isParagraphBreak =
            prevBlockType !== null &&
            (
              prevBlockType !== b.blockType ||
              paragraphGap >= FLOW_PARAGRAPH_GAP_PX + 4 ||
              semanticBoundaryBreak
            );
          const flowGap = prevBlockType === null
            ? 0
            : isParagraphBreak
              ? paragraphGap
              : FLOW_LINE_GAP_PX;
          const minTopByFlow = cursorBottom + flowGap;
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
            continuesFromPrevPage: false,
            continuesToNextPage: false,
          });

          if (!strictMappingLayout && b.blockType === "TEXT") {
            const sourceFontSize = estimateFontSizePx(
              { width: sourceWidth, height: baseHeight },
              b.text,
            );
            const sourceLineEstimate = estimateLineCount(
              b.text,
              Math.max(2, sourceWidth),
              sourceFontSize,
            );
            const sourceWidthRatio = clamp(
              sourceWidth / Math.max(1, maxReadableWidth),
              FLOW_PARAGRAPH_MIN_WIDTH_RATIO,
              FLOW_PARAGRAPH_MAX_WIDTH_RATIO,
            );
            const sourceIndentRatio = clamp(
              (baseLeft - pageTextInset) / Math.max(1, maxReadableWidth),
              0,
              FLOW_PARAGRAPH_MAX_INDENT_RATIO,
            );
            const segment: FlowSegment = {
              anchorId: b.anchorId,
              text: displayText,
              fontSize,
              sourceWidthRatio,
              sourceIndentRatio,
              sourceLineEstimate: Math.max(1, sourceLineEstimate),
              blockType: b.blockType,
              hasFailure,
              hasTranslation,
              isPending,
              failureReason: hasFailure ? failureReason : undefined,
              continuesFromPrevPage: false,
              continuesToNextPage: false,
            };
            flowSegmentByAnchor.set(b.anchorId, segment);

            if (!currentParagraph || isParagraphBreak) {
              currentParagraph = openParagraph(
                b.anchorId,
                flowGap,
                baseTop,
                clamp(baseLeft / Math.max(1, renderedWidth), 0, 0.92),
              );
            }

            if (currentParagraph.segments.length === 0) {
              currentParagraph.baseIndentRatio = sourceIndentRatio;
            }
            currentParagraph.segments.push(segment);
            currentParagraph.targetLineCount += segment.sourceLineEstimate;
            currentParagraph.baseWidthRatio += sourceWidthRatio;
          }

          anchors.push({
            anchorId: b.anchorId,
            top: offsetTop + top,
            bottom: offsetTop + bottom,
          });

          cursorBottom = strictMappingLayout ? Math.max(cursorBottom, bottom) : bottom;
          prevBaseBottom = baseTop + baseHeight;
          prevBlockType = b.blockType;
          prevSourceText = b.text;
          prevSourceWidth = sourceWidth;
        }

        for (const paragraph of flowParagraphs) {
          const segmentCount = paragraph.segments.length;
          if (segmentCount === 0) continue;
          const avgWidthRatio = paragraph.baseWidthRatio / segmentCount;
          const paragraphText = paragraph.segments.map((seg) => seg.text).join(" ");
          const kind = classifyParagraphKind(paragraphText, paragraph.segments);
          paragraph.kind = kind;
          paragraph.baseWidthRatio = widthRatioByKind(avgWidthRatio, kind);
          paragraph.targetLineCount = clamp(paragraph.targetLineCount, 1, 200);
        }

        // Keep paragraph start points close to source geometry while preserving normal flow.
        for (let i = 0; i < flowParagraphs.length; i++) {
          const paragraph = flowParagraphs[i]!;
          if (i === 0) {
            const anchoredTop = clamp(
              paragraph.sourceTopPx * FLOW_FIRST_PARAGRAPH_TOP_WEIGHT,
              0,
              FLOW_FIRST_PARAGRAPH_TOP_MAX_PX,
            );
            paragraph.gapBeforePx = paragraphGapByKind(anchoredTop, paragraph.kind);
            continue;
          }

          const prev = flowParagraphs[i - 1]!;
          const sourceGap = Math.max(0, paragraph.sourceTopPx - prev.sourceTopPx);
          const blendedGap =
            sourceGap * FLOW_START_ANCHOR_GAP_WEIGHT +
            paragraph.gapBeforePx * (1 - FLOW_START_ANCHOR_GAP_WEIGHT);
          paragraph.gapBeforePx = paragraphGapByKind(
            clamp(blendedGap, FLOW_PARAGRAPH_GAP_PX, FLOW_FIRST_PARAGRAPH_TOP_MAX_PX),
            paragraph.kind,
          );
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
        flowParagraphMap.set(ps.pageNumber, flowParagraphs);
        offsetTop += renderedHeight + PAGE_GAP_PX;
      }

      // If a sentence is split at a page boundary, mark it as continuation.
      for (let i = 0; i < pageMetas.length - 1; i++) {
        const currentPageNo = pageMetas[i]!.pageNumber;
        const nextPageNo = pageMetas[i + 1]!.pageNumber;
        const currentBlocks = blockMap.get(currentPageNo) ?? [];
        const nextBlocks = blockMap.get(nextPageNo) ?? [];
        const last = [...currentBlocks].reverse().find((b) => b.displayText.trim().length > 0);
        const first = nextBlocks.find((b) => b.displayText.trim().length > 0);
        if (!last || !first) continue;
        if (!shouldMarkPageContinuation(last.displayText, first.displayText)) continue;
        last.continuesToNextPage = true;
        first.continuesFromPrevPage = true;
        const lastFlow = flowSegmentByAnchor.get(last.anchorId);
        const firstFlow = flowSegmentByAnchor.get(first.anchorId);
        if (lastFlow) lastFlow.continuesToNextPage = true;
        if (firstFlow) firstFlow.continuesFromPrevPage = true;
      }

      anchors.sort((a, b) => a.top - b.top);
      return {
        pages: pageMetas,
        renderedBlocksByPage: blockMap,
        flowParagraphsByPage: flowParagraphMap,
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

    const effectiveAnchorLayouts = useMemo(
      () => (measuredFlowAnchors.length > 0 ? measuredFlowAnchors : anchorLayouts),
      [anchorLayouts, measuredFlowAnchors],
    );

    const anchorPositions = useMemo(
      () => new Map(effectiveAnchorLayouts.map((a) => [a.anchorId, a.top])),
      [effectiveAnchorLayouts],
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
      setMeasuredFlowAnchors([]);
      setParagraphWidthTuning({});
      setParagraphTunePass(0);
    }, [docKey, pageSizes.length, renderMode]);

    useEffect(() => {
      if (!mappingMode) return;
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
    }, [mappingMode, pages, renderedBlocksByPage, translations, translationFailures, renderMode]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el || pages.length === 0) return;

      const raf = requestAnimationFrame(() => {
        const rootRect = el.getBoundingClientRect();
        const merged = new Map<string, { top: number; bottom: number }>();

        el.querySelectorAll<HTMLElement>("[data-flow-anchor-id]").forEach((segEl) => {
          const anchorId = segEl.dataset.flowAnchorId;
          if (!anchorId) return;
          const r = segEl.getBoundingClientRect();
          const top = el.scrollTop + (r.top - rootRect.top);
          const bottom = el.scrollTop + (r.bottom - rootRect.top);
          const prev = merged.get(anchorId);
          if (!prev) {
            merged.set(anchorId, { top, bottom });
            return;
          }
          prev.top = Math.min(prev.top, top);
          prev.bottom = Math.max(prev.bottom, bottom);
        });

        const measured = Array.from(merged.entries())
          .map(([anchorId, v]) => ({ anchorId, top: v.top, bottom: v.bottom }))
          .sort((a, b) => a.top - b.top);

        setMeasuredFlowAnchors((prev) => {
          if (prev.length === measured.length) {
            let same = true;
            for (let i = 0; i < prev.length; i++) {
              const p = prev[i]!;
              const n = measured[i]!;
              if (
                p.anchorId !== n.anchorId ||
                Math.abs(p.top - n.top) > 1 ||
                Math.abs(p.bottom - n.bottom) > 1
              ) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return measured;
        });
      });

      return () => cancelAnimationFrame(raf);
    }, [flowParagraphsByPage, pages, renderMode, translations, translationFailures]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el || pages.length === 0) return;
      if (paragraphTunePass >= FLOW_WIDTH_TUNE_PASS_LIMIT) return;

      const raf = requestAnimationFrame(() => {
        const updates: Record<string, number> = {};

        el.querySelectorAll<HTMLElement>("[data-flow-paragraph-id]").forEach((paragraphEl) => {
          const paragraphId = paragraphEl.dataset.flowParagraphId;
          const paragraphKind = paragraphEl.dataset.paragraphKind as ParagraphKind | undefined;
          const targetLinesRaw = paragraphEl.dataset.targetLines;
          if (!paragraphId || !targetLinesRaw) return;
          if (paragraphKind === "heading") return;

          const targetLines = Number.parseInt(targetLinesRaw, 10);
          if (!Number.isFinite(targetLines) || targetLines <= 0) return;

          const computed = window.getComputedStyle(paragraphEl);
          const fontSizePx = Number.parseFloat(computed.fontSize);
          const lineHeightPxFromStyle = Number.parseFloat(computed.lineHeight);
          const lineHeightPx =
            Number.isFinite(lineHeightPxFromStyle) && lineHeightPxFromStyle > 0
              ? lineHeightPxFromStyle
              : Math.max(1, (Number.isFinite(fontSizePx) ? fontSizePx : 13) * 1.3);

          const measuredHeight = paragraphEl.getBoundingClientRect().height;
          const measuredLines = Math.max(1, Math.round(measuredHeight / lineHeightPx));
          const diff = measuredLines - targetLines;
          if (Math.abs(diff) < FLOW_WIDTH_TUNE_THRESHOLD_LINES) return;

          const step =
            Math.abs(diff) >= FLOW_WIDTH_TUNE_THRESHOLD_LINES + 2
              ? FLOW_WIDTH_TUNE_STEP_LARGE
              : FLOW_WIDTH_TUNE_STEP;
          updates[paragraphId] = diff > 0 ? step : -step;
        });

        if (Object.keys(updates).length === 0) return;

        setParagraphWidthTuning((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [paragraphId, delta] of Object.entries(updates)) {
            const prevValue = next[paragraphId] ?? 0;
            const nextValue = clamp(
              prevValue + delta,
              FLOW_WIDTH_TUNE_MIN,
              FLOW_WIDTH_TUNE_MAX,
            );
            if (Math.abs(nextValue - prevValue) < 0.007) continue;
            next[paragraphId] = nextValue;
            changed = true;
          }
          if (!changed) return prev;
          return next;
        });
        setParagraphTunePass((prev) => prev + 1);
      });

      return () => cancelAnimationFrame(raf);
    }, [
      flowParagraphsByPage,
      pages,
      paragraphTunePass,
      renderMode,
      translations,
      translationFailures,
    ]);

    useEffect(() => {
      if (!pdfData || pages.length === 0 || pagesWithImages.size === 0) return;

      let cancelled = false;
      (async () => {
        const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
        const { GlobalWorkerOptions, getDocument } = pdfjs as unknown as {
          GlobalWorkerOptions?: { workerSrc?: string };
          getDocument: (input: { data: ArrayBuffer }) => { promise: Promise<{
            getPage: (pageNumber: number) => Promise<{
              getViewport: (params: { scale: number }) => { width: number; height: number };
              render: (params: {
                canvas: HTMLCanvasElement;
                canvasContext: CanvasRenderingContext2D;
                viewport: { width: number; height: number };
              }) => { promise: Promise<void> };
            }>;
          }> };
        };
        const workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        if (GlobalWorkerOptions) {
          GlobalWorkerOptions.workerSrc = `${workerSrc}?v=20260219-trbg`;
        }

        const loadingTask = getDocument({ data: pdfData.slice(0) });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const pageMetaByNumber = new Map(pages.map((p) => [p.pageNumber, p]));
        const targetPages = Array.from(pagesWithImages.values()).sort((a, b) => a - b);

        for (const pageNumber of targetPages) {
          if (cancelled) return;
          const pageMeta = pageMetaByNumber.get(pageNumber);
          if (!pageMeta) continue;
          const canvas = document.getElementById(
            `tr-bg-canvas-${pageNumber}`,
          ) as HTMLCanvasElement | null;
          if (!canvas) continue;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;

          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: pageMeta.scale });

          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.style.pointerEvents = "none";

          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
          if (cancelled) return;

          // Remove source text from background so only non-text graphics remain.
          ctx.save();
          ctx.fillStyle = "#ffffff";
          const pageBlocks = blocksByPage.get(pageNumber) ?? [];
          for (const block of pageBlocks) {
            for (const ring of block.geometry.rings) {
              const scaled = scaleRingPoints(ring, pageMeta.scale);
              if (scaled.length < 3) continue;
              ctx.beginPath();
              ctx.moveTo(scaled[0]!.x, scaled[0]!.y);
              for (let i = 1; i < scaled.length; i++) {
                ctx.lineTo(scaled[i]!.x, scaled[i]!.y);
              }
              ctx.closePath();
              ctx.fill();
            }
          }
          ctx.restore();
        }
      })().catch((e) => {
        console.error("[translated-pdf] background image render failed", e);
      });

      return () => {
        cancelled = true;
      };
    }, [blocksByPage, pages, pagesWithImages, pdfData]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      let raf = 0;
      const onScroll = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
        const viewportTop = el.scrollTop;
        const viewportBottom = viewportTop + el.clientHeight;
        const viewportAnchorTarget =
          viewportTop + Math.min(180, Math.max(48, el.clientHeight * 0.26));

          let primary: { anchorId: string; dist: number } | null = null;
          for (const layout of effectiveAnchorLayouts) {
            if (layout.bottom < viewportTop) continue;
            if (layout.top > viewportBottom) break;
            const center = (layout.top + layout.bottom) / 2;
            const dist = Math.abs(center - viewportAnchorTarget);
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
    }, [blocks, effectiveAnchorLayouts, onUserScrollAnchorChange]);

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
                const pageFlowParagraphs = flowParagraphsByPage.get(p.pageNumber) ?? [];
                return (
                  <div
                    key={p.pageNumber}
                    className="relative mx-auto rounded-md bg-white shadow"
                    style={{
                      width: Math.floor(p.renderedWidth),
                      minHeight: Math.floor(p.renderedHeight),
                    }}
                    data-page-number={p.pageNumber}
                  >
                    {pagesWithImages.has(p.pageNumber) ? (
                      <canvas
                        id={`tr-bg-canvas-${p.pageNumber}`}
                        className="pointer-events-none absolute left-0 top-0 z-0 rounded-md"
                        aria-label={`page-${p.pageNumber}-image-layer`}
                      />
                    ) : null}
                    <div className={`relative z-10 ${mappingMode ? "px-4 py-4" : "px-5 py-5"}`}>
                      {pageFlowParagraphs.length === 0 ? (
                        <div
                          className="h-2"
                          aria-label="empty-page"
                        />
                      ) : (
                        pageFlowParagraphs.map((paragraph) => {
                          const paragraphText = paragraph.segments.map((s) => s.text).join(" ");
                          const paragraphHasCjk = hasCjkCharacters(paragraphText);
                          const paragraphFontFamily = paragraphHasCjk
                            ? "'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', sans-serif"
                            : "ui-serif, Georgia, 'Times New Roman', serif";
                          const paragraphKind = paragraph.kind;
                          const paragraphLineHeightBase = paragraphHasCjk ? 1.36 : 1.28;
                          const paragraphLineHeight =
                            paragraphKind === "heading"
                              ? paragraphLineHeightBase - 0.08
                              : paragraphKind === "toc"
                                ? paragraphLineHeightBase + 0.02
                                : paragraphKind === "list"
                                  ? paragraphLineHeightBase + 0.01
                                  : paragraphLineHeightBase;
                          const paragraphFontSizeBase = clamp(
                            paragraph.segments.reduce((sum, s) => sum + s.fontSize, 0) /
                              Math.max(1, paragraph.segments.length),
                            12,
                            18,
                          );
                          const paragraphFontSize =
                            paragraphKind === "heading"
                              ? clamp(paragraphFontSizeBase + 1.2, 12.5, 20)
                              : paragraphKind === "toc"
                                ? clamp(paragraphFontSizeBase + 0.35, 12, 18.5)
                                : paragraphFontSizeBase;
                          const tuningDelta = paragraphWidthTuning[paragraph.id] ?? 0;
                          const indentRatio =
                            paragraphKind === "heading"
                              ? paragraph.sourceLeftRatio
                              : paragraphKind === "toc"
                                ? Math.max(paragraph.baseIndentRatio, paragraph.sourceLeftRatio * 0.78)
                                : paragraph.baseIndentRatio;
                          const maxIndentRatio =
                            paragraphKind === "heading"
                              ? FLOW_PARAGRAPH_HEADING_MAX_INDENT_RATIO
                              : paragraphKind === "toc"
                                ? Math.max(FLOW_PARAGRAPH_MAX_INDENT_RATIO, 0.34)
                                : FLOW_PARAGRAPH_MAX_INDENT_RATIO;
                          const marginLeftPercent = clamp(
                            indentRatio * 100,
                            0,
                            maxIndentRatio * 100,
                          );
                          const maxWidthPercent = clamp(
                            (paragraph.baseWidthRatio + tuningDelta) * 100,
                            FLOW_PARAGRAPH_MIN_WIDTH_RATIO * 100,
                            Math.max(FLOW_PARAGRAPH_MIN_WIDTH_RATIO * 100, 100 - marginLeftPercent),
                          );
                          const hasCarryIn = paragraph.segments.some((seg) => seg.continuesFromPrevPage);
                          const hasCarryOut = paragraph.segments.some((seg) => seg.continuesToNextPage);
                          const paragraphDebugLabel =
                            paragraphKind === "body"
                              ? null
                              : `${paragraphKind}${hasCarryIn || hasCarryOut ? " · carry" : ""}`;

                          return (
                            <div
                              key={paragraph.id}
                              data-flow-paragraph-id={paragraph.id}
                              data-target-lines={paragraph.targetLineCount}
                              data-paragraph-kind={paragraph.kind}
                              className="text-zinc-900"
                              style={{
                                marginTop: paragraph.gapBeforePx,
                                marginLeft: `${marginLeftPercent}%`,
                                maxWidth: `${maxWidthPercent}%`,
                                fontSize: paragraphFontSize,
                                lineHeight: paragraphLineHeight,
                                fontFamily: paragraphFontFamily,
                              }}
                            >
                              {mappingMode && paragraphDebugLabel ? (
                                <div className="mb-1">
                                  <span
                                    className="inline-block rounded border px-1.5 py-[1px] text-[10px] font-mono leading-none"
                                    style={{
                                      borderColor: "#c084fc",
                                      color: "#6d28d9",
                                      backgroundColor: "rgba(233,213,255,0.42)",
                                    }}
                                  >
                                    {paragraphDebugLabel}
                                  </span>
                                </div>
                              ) : null}
                              <p>
                                {paragraph.segments.map((seg, segIdx) => {
                                  let renderedText = seg.text;
                                  if (seg.continuesFromPrevPage) renderedText = `… ${renderedText}`;
                                  if (seg.continuesToNextPage) renderedText = `${renderedText} …`;
                                  const next = paragraph.segments[segIdx + 1];
                                  const joiner = next ? joinerForFlow(seg.text, next.text) : "";
                                  const segActive = seg.anchorId === activeAnchorId;
                                  const segHover = seg.anchorId === hoverAnchorId;
                                  const debugStroke = segActive
                                    ? "rgba(251,191,36,0.98)"
                                    : segHover
                                      ? "rgba(34,211,238,0.98)"
                                      : anchorStrokeColor(seg.anchorId);
                                  const segColor = seg.hasFailure
                                    ? "#9f1239"
                                    : seg.hasTranslation
                                      ? "#111"
                                      : renderMode === "reader"
                                        ? "#71717a"
                                        : "#555";

                                  return (
                                    <span key={seg.anchorId}>
                                      {mappingMode ? (
                                        <span
                                          className="mr-1 inline-block rounded px-1 py-[1px] align-middle text-[9px] font-mono leading-none text-white"
                                          style={{ backgroundColor: debugStroke }}
                                          title={seg.anchorId}
                                        >
                                          {seg.anchorId}
                                        </span>
                                      ) : null}
                                      <span
                                        data-flow-anchor-id={seg.anchorId}
                                        data-anchor-id={seg.anchorId}
                                        className={mappingMode ? "inline rounded-sm border px-1 py-[1px]" : undefined}
                                        style={{
                                          color: segColor,
                                          borderColor: mappingMode ? debugStroke : undefined,
                                          backgroundColor: mappingMode
                                            ? segActive
                                              ? "rgba(251,191,36,0.2)"
                                              : segHover
                                                ? "rgba(34,211,238,0.13)"
                                                : "transparent"
                                            : segActive
                                              ? "rgba(251,191,36,0.2)"
                                              : segHover
                                                ? "rgba(34,211,238,0.13)"
                                                : undefined,
                                          borderRadius: mappingMode || segActive || segHover ? 2 : undefined,
                                          padding: mappingMode || segActive || segHover ? "0 1px" : undefined,
                                          whiteSpace: "pre-wrap",
                                          wordBreak: paragraphHasCjk ? "keep-all" : "break-word",
                                          overflowWrap: "anywhere",
                                        }}
                                        title={
                                          seg.hasFailure && seg.failureReason
                                            ? `${seg.anchorId} • ${seg.failureReason}`
                                            : seg.anchorId
                                        }
                                        onMouseEnter={() => onAnchorHoverChange?.(seg.anchorId)}
                                      >
                                        {renderedText}
                                      </span>
                                      {joiner}
                                    </span>
                                  );
                                })}
                              </p>
                            </div>
                          );
                        })
                      )}
                    </div>
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

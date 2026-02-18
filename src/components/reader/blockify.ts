export type TextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export type BlockOut = {
  orderInPage: number;
  bbox: BBox;
  text: string;
  blockType: "TEXT" | "CODE" | "MATH";
};

type Line = {
  y: number;
  items: TextItem[];
  bbox: BBox;
  text: string;
  startX: number;
  endX: number;
};

function mergeBbox(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function itemBbox(i: TextItem): BBox {
  return {
    minX: i.x,
    minY: i.y,
    maxX: i.x + i.width,
    maxY: i.y + i.height,
  };
}

function classifyBlock(text: string): "TEXT" | "CODE" | "MATH" {
  const t = text.trim();
  if (!t) return "TEXT";

  // Very rough heuristics for MVP.
  const codeChars = /[{}();<>[\]=_]/g;
  const mathChars = /[∑∫√≈≠≤≥±×÷πλμθ]/g;

  const codeCount = (t.match(codeChars) ?? []).length;
  const mathCount = (t.match(mathChars) ?? []).length;

  const nonWord = (t.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  const ratio = nonWord / Math.max(1, t.length);

  if (codeCount >= 4 || ratio > 0.28) return "CODE";
  if (mathCount >= 2) return "MATH";
  return "TEXT";
}

function bboxWidth(b: BBox): number {
  return Math.max(0, b.maxX - b.minX);
}

function xOverlapRatio(a: BBox, b: BBox): number {
  const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const base = Math.max(1, Math.min(bboxWidth(a), bboxWidth(b)));
  return overlap / base;
}

const LINE_TOLERANCE = 4.2;
const SPACE_THRESHOLD = 6;
const PARA_GAP = 10;
const UPWARD_TOLERANCE = 2;
const MIN_SHORT_BLOCK_LEN = 20;
const SHORT_MERGE_MAX_GAP = 20;
const MAX_SENTENCE_CHARS = 1200;
const MIN_SENTENCE_FLUSH_CHARS = 8;
const SENTENCE_END_RE = /(?:[.!?…]["')\]]*|[。！？])$/;
const CLOSER_CHARS_RE = /["')\]]/;
const SENTENCE_PUNCT_RE = /[.!?…。！？]/;
const COMMON_ABBREV_RE =
  /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Fig|Eq|No|pp|i\.e|e\.g)\.$/i;

function isTinyToken(item: TextItem): boolean {
  const compact = item.str.replace(/\s+/g, "");
  if (compact.length === 0) return false;
  if (/^[•▪◦·]$/.test(compact)) return false;
  if (compact.length > 2) return false;
  return item.width <= Math.max(10, item.height * 0.95);
}

function joinTokenText(left: string, right: string, gap: number): string {
  if (!left) return right;
  if (!right) return left;
  const needsSpace = gap > 2.8;
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}

function mergeTinyTokensInLine(lineItems: TextItem[]): TextItem[] {
  const items = lineItems.map((it) => ({ ...it }));
  let i = 0;
  while (i < items.length) {
    const cur = items[i]!;
    if (!isTinyToken(cur)) {
      i += 1;
      continue;
    }

    const prev = i > 0 ? items[i - 1]! : null;
    const next = i + 1 < items.length ? items[i + 1]! : null;
    const gapLeft = prev ? cur.x - (prev.x + prev.width) : Number.POSITIVE_INFINITY;
    const gapRight = next ? next.x - (cur.x + cur.width) : Number.POSITIVE_INFINITY;
    const maxGap = Math.max(5, cur.height);

    const canMergeLeft = !!prev && gapLeft >= -1 && gapLeft <= maxGap;
    const canMergeRight = !!next && gapRight >= -1 && gapRight <= maxGap;

    if (canMergeLeft && (!canMergeRight || gapLeft <= gapRight)) {
      prev.str = joinTokenText(prev.str, cur.str, gapLeft);
      const prevRight = Math.max(prev.x + prev.width, cur.x + cur.width);
      prev.width = prevRight - prev.x;
      const prevTop = Math.min(prev.y, cur.y);
      const prevBottom = Math.max(prev.y + prev.height, cur.y + cur.height);
      prev.y = prevTop;
      prev.height = prevBottom - prevTop;
      items.splice(i, 1);
      continue;
    }

    if (canMergeRight) {
      const nextLeft = Math.min(next.x, cur.x);
      const nextRight = Math.max(next.x + next.width, cur.x + cur.width);
      const nextTop = Math.min(next.y, cur.y);
      const nextBottom = Math.max(next.y + next.height, cur.y + cur.height);
      next.str = joinTokenText(cur.str, next.str, gapRight);
      next.x = nextLeft;
      next.width = nextRight - nextLeft;
      next.y = nextTop;
      next.height = nextBottom - nextTop;
      items.splice(i, 1);
      continue;
    }

    i += 1;
  }
  return items;
}

function normalizeItems(items: TextItem[]): TextItem[] {
  const clean = items
    .map((i) => ({ ...i, str: (i.str ?? "").replace(/\s+/g, " ").trim() }))
    .filter((i) => i.str.length > 0)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const lineBuckets: TextItem[][] = [];
  for (const it of clean) {
    const last = lineBuckets[lineBuckets.length - 1];
    if (last) {
      const yAvg = last.reduce((sum, v) => sum + v.y, 0) / last.length;
      if (Math.abs(yAvg - it.y) <= LINE_TOLERANCE) {
        last.push(it);
        continue;
      }
    }
    lineBuckets.push([it]);
  }

  const merged: TextItem[] = [];
  for (const lineItems of lineBuckets) {
    const sorted = [...lineItems].sort((a, b) => a.x - b.x);
    merged.push(...mergeTinyTokensInLine(sorted));
  }
  merged.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  return merged;
}

function buildLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  for (const it of items) {
    const bb = itemBbox(it);
    const y = it.y;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= LINE_TOLERANCE) {
      last.items.push(it);
      last.bbox = mergeBbox(last.bbox, bb);
      continue;
    }
    lines.push({
      y,
      items: [it],
      bbox: bb,
      text: "",
      startX: it.x,
      endX: it.x + it.width,
    });
  }

  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let out = "";
    let prevEnd = -Infinity;
    let prevToken = "";
    for (const it of ln.items) {
      const gap = it.x - prevEnd;
      const adaptiveSpaceThreshold = Math.max(
        1.6,
        Math.min(SPACE_THRESHOLD, Math.min(4.8, it.height * 0.22)),
      );
      const alphaNumGapSpace =
        gap > 0.9 && /[A-Za-z0-9]$/.test(prevToken) && /^[A-Za-z0-9]/.test(it.str);
      if (out && (gap > adaptiveSpaceThreshold || alphaNumGapSpace)) out += " ";
      out += it.str;
      prevEnd = it.x + it.width;
      prevToken = it.str;
    }
    ln.text = out.trim();
    ln.startX = ln.items[0]!.x;
    ln.endX = prevEnd;
    ln.bbox = ln.items.reduce((acc, item, idx) => {
      const bb = itemBbox(item);
      return idx === 0 ? bb : mergeBbox(acc, bb);
    }, itemBbox(ln.items[0]!));
  }

  return lines.filter((ln) => ln.text.length > 0);
}

function normalizeLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function startsLowerAlpha(text: string): boolean {
  return /^[a-z]/.test(text.trim());
}

function isLikelyDropCap(text: string): boolean {
  return /^[A-Za-z]$/.test(text.trim());
}

function isLikelyListLikeParagraph(lines: Line[]): boolean {
  if (lines.length < 4) return false;

  let total = 0;
  let shortLines = 0;
  let upperOrDigitStart = 0;
  let lowerStart = 0;
  let sentenceEnded = 0;

  for (const ln of lines) {
    const text = normalizeLineText(ln.text);
    if (!text) continue;
    total += 1;
    const words = text.split(/\s+/).length;
    if (words <= 15 && text.length <= 120) shortLines += 1;
    if (/^(?:\[|[A-Z0-9"'(])/.test(text)) upperOrDigitStart += 1;
    if (/^[a-z]/.test(text)) lowerStart += 1;
    if (SENTENCE_END_RE.test(text)) sentenceEnded += 1;
  }

  if (total < 4) return false;
  const shortRatio = shortLines / total;
  const upperRatio = upperOrDigitStart / total;
  const lowerRatio = lowerStart / total;
  const sentenceEndRatio = sentenceEnded / total;
  return shortRatio >= 0.72 && upperRatio >= 0.58 && lowerRatio <= 0.35 && sentenceEndRatio <= 0.25;
}

function splitListLikeParagraph(lines: Line[]): Array<{ bbox: BBox; text: string }> {
  const out: Array<{ bbox: BBox; text: string }> = [];
  let curText = "";
  let curBbox: BBox | null = null;
  let curStartX = 0;

  const flush = () => {
    const text = normalizeLineText(curText);
    if (!text || !curBbox) return;
    out.push({ bbox: curBbox, text });
    curText = "";
    curBbox = null;
  };

  for (const ln of lines) {
    const text = normalizeLineText(ln.text);
    if (!text) continue;

    if (!curBbox) {
      curText = text;
      curBbox = ln.bbox;
      curStartX = ln.startX;
      continue;
    }

    const continuationByIndent = ln.startX > curStartX + 14;
    const continuationByCase = startsLowerAlpha(text);
    const continuationByPunct = /^[,.;:)\]]/.test(text);
    if (continuationByIndent || continuationByCase || continuationByPunct) {
      curText = `${curText} ${text}`;
      curBbox = mergeBbox(curBbox, ln.bbox);
      continue;
    }

    flush();
    curText = text;
    curBbox = ln.bbox;
    curStartX = ln.startX;
  }

  flush();
  return out;
}

function splitParagraphIntoUnits(lines: Line[]): Array<{ bbox: BBox; text: string }> {
  const cleanLines = lines
    .map((ln) => ({ ...ln, text: normalizeLineText(ln.text) }))
    .filter((ln) => ln.text.length > 0);
  if (cleanLines.length === 0) return [];

  if (isLikelyListLikeParagraph(cleanLines)) {
    const listUnits = splitListLikeParagraph(cleanLines);
    if (listUnits.length > 0) return listUnits;
  }

  const out: Array<{ bbox: BBox; text: string }> = [];
  let sentenceText = "";
  let sentenceBbox: BBox | null = null;
  let sentenceChars = 0;
  let joinNextWithoutSpace = false;

  const flush = () => {
    const text = sentenceText.trim();
    if (text.length === 0) {
      sentenceText = "";
      sentenceBbox = null;
      sentenceChars = 0;
      return;
    }
    if (sentenceBbox) out.push({ bbox: sentenceBbox, text });
    sentenceText = "";
    sentenceBbox = null;
    sentenceChars = 0;
  };

  const appendText = (chunk: string, bbox: BBox, withSpace: boolean) => {
    if (!chunk) return;
    if (withSpace && sentenceText.length > 0 && !sentenceText.endsWith(" ")) {
      sentenceText += " ";
      sentenceChars += 1;
    }
    sentenceText += chunk;
    sentenceChars += chunk.length;
    sentenceBbox = sentenceBbox ? mergeBbox(sentenceBbox, bbox) : bbox;

    const endsSentence = SENTENCE_END_RE.test(sentenceText.trim());
    const isHardCut = sentenceChars >= MAX_SENTENCE_CHARS;
    if ((endsSentence && sentenceChars >= MIN_SENTENCE_FLUSH_CHARS) || isHardCut) {
      flush();
    }
  };

  const splitSentenceLikeParts = (text: string): string[] => {
    const src = text.trim();
    if (!src) return [];

    const out: string[] = [];
    let start = 0;
    let i = 0;

    const isLikelyDotAbbrev = (s: string, dotIndex: number) => {
      const prev = s.slice(Math.max(0, dotIndex - 14), dotIndex + 1);
      if (COMMON_ABBREV_RE.test(prev)) return true;
      if (/\b[A-Z]\.$/.test(prev)) return true;
      if (/\d\.$/.test(prev) && /\d/.test(s[dotIndex + 1] ?? "")) return true;
      return false;
    };

    while (i < src.length) {
      const ch = src[i]!;
      if (!SENTENCE_PUNCT_RE.test(ch)) {
        i += 1;
        continue;
      }

      if (ch === "." && isLikelyDotAbbrev(src, i)) {
        i += 1;
        continue;
      }

      let end = i + 1;
      while (end < src.length && CLOSER_CHARS_RE.test(src[end]!)) end += 1;

      const piece = src.slice(start, end).trim();
      if (piece.length >= MIN_SENTENCE_FLUSH_CHARS) out.push(piece);
      start = end;
      while (start < src.length && /\s/.test(src[start]!)) start += 1;
      i = start;
    }

    const tail = src.slice(start).trim();
    if (tail.length > 0) out.push(tail);
    return out.length > 0 ? out : [src];
  };

  for (let i = 0; i < cleanLines.length; i++) {
    const ln = cleanLines[i]!;
    const text = ln.text;
    const parts = splitSentenceLikeParts(text);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]!;
      const withSpace =
        sentenceText.length > 0 &&
        !joinNextWithoutSpace &&
        !sentenceText.endsWith("-") &&
        !/^[,.;:)\]]/.test(part);
      appendText(part, ln.bbox, withSpace);
      joinNextWithoutSpace = false;
    }
    joinNextWithoutSpace = false;

    if (isLikelyDropCap(text) && i + 1 < cleanLines.length) {
      joinNextWithoutSpace = true;
      continue;
    }
  }
  flush();

  if (out.length > 0) return out;

  const fallbackText = cleanLines.map((ln) => ln.text).join("\n").trim();
  if (!fallbackText) return [];
  const fallbackBbox = cleanLines
    .map((ln) => ln.bbox)
    .reduce((acc, bb) => mergeBbox(acc, bb));
  return [{ bbox: fallbackBbox, text: fallbackText }];
}

export function blockifyPage(items: TextItem[], pageWidth: number): BlockOut[] {
  const normalized = normalizeItems(items);
  const lines = buildLines(normalized);

  // Column detection: find a big gap between line start positions.
  const starts = lines.map((l) => l.startX).sort((a, b) => a - b);
  let boundary: number | null = null;
  let bestGap = 0;
  for (let i = 0; i < starts.length - 1; i++) {
    const gap = starts[i + 1]! - starts[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      boundary = (starts[i + 1]! + starts[i]!) / 2;
    }
  }
  const isTwoColumn = boundary !== null && bestGap > pageWidth * 0.22;

  const ordered = [...lines].sort((a, b) => {
    const ca = isTwoColumn && boundary !== null ? (a.startX < boundary ? 0 : 1) : 0;
    const cb = isTwoColumn && boundary !== null ? (b.startX < boundary ? 0 : 1) : 0;
    if (ca !== cb) return ca - cb;
    return a.y - b.y;
  });

  const blocks: BlockOut[] = [];
  let current: { bbox: BBox; lines: Line[] } | null = null;
  const pushParagraph = (paragraphLines: Line[]) => {
    const units = splitParagraphIntoUnits(paragraphLines);
    for (const unit of units) {
      blocks.push({
        orderInPage: blocks.length,
        bbox: unit.bbox,
        text: unit.text,
        blockType: classifyBlock(unit.text),
      });
    }
  };

  for (const ln of ordered) {
    if (!current) {
      current = { bbox: ln.bbox, lines: [ln] };
      continue;
    }
    const prev = current.lines[current.lines.length - 1]!;
    const gap = ln.bbox.minY - prev.bbox.maxY;
    if (gap >= -UPWARD_TOLERANCE && gap <= PARA_GAP) {
      current.lines.push(ln);
      current.bbox = mergeBbox(current.bbox, ln.bbox);
    } else {
      pushParagraph(current.lines);
      current = { bbox: ln.bbox, lines: [ln] };
    }
  }
  if (current) pushParagraph(current.lines);

  // Merge very short blocks into the next one only when locally adjacent.
  const merged: BlockOut[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const len = b.text.replace(/\s+/g, " ").trim().length;
    const next = blocks[i + 1];
    const compact = b.text.replace(/\s+/g, "").trim();
    const canMergeDropCap =
      compact.length <= 2 &&
      /^[A-Za-z]{1,2}$/.test(compact) &&
      !!next &&
      next.bbox.minY - b.bbox.maxY >= -UPWARD_TOLERANCE &&
      next.bbox.minY - b.bbox.maxY <= SHORT_MERGE_MAX_GAP * 2 &&
      next.bbox.minX >= b.bbox.minX - 8 &&
      next.bbox.minX <= b.bbox.minX + 80;
    const canMergeShort =
      len < MIN_SHORT_BLOCK_LEN &&
      !!next &&
      next.bbox.minY - b.bbox.maxY >= -UPWARD_TOLERANCE &&
      next.bbox.minY - b.bbox.maxY <= SHORT_MERGE_MAX_GAP &&
      xOverlapRatio(b.bbox, next.bbox) >= 0.45;

    if ((canMergeDropCap || canMergeShort) && next) {
      const mergedText = canMergeDropCap
        ? `${compact}${next.text}`.trim()
        : `${b.text}\n${next.text}`.trim();
      blocks[i + 1] = {
        ...next,
        bbox: mergeBbox(b.bbox, next.bbox),
        text: mergedText,
        blockType: classifyBlock(mergedText),
      };
      continue;
    }
    merged.push({ ...b, orderInPage: merged.length });
  }

  return merged;
}

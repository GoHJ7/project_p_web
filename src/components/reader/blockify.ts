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

export function blockifyPage(items: TextItem[], pageWidth: number): BlockOut[] {
  const clean = items
    .map((i) => ({ ...i, str: (i.str ?? "").replace(/\s+/g, " ").trim() }))
    .filter((i) => i.str.length > 0)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const lineTolerance = 2.5;
  const lines: Line[] = [];

  for (const it of clean) {
    const bb = itemBbox(it);
    const y = it.y;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= lineTolerance) {
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

  // Build line text and bbox.
  const spaceThreshold = 6;
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let out = "";
    let prevEnd = -Infinity;
    for (const it of ln.items) {
      const gap = it.x - prevEnd;
      if (out && gap > spaceThreshold) out += " ";
      out += it.str;
      prevEnd = it.x + it.width;
    }
    ln.text = out.trim();
    ln.startX = ln.items[0]!.x;
    ln.endX = prevEnd;
  }

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

  // Paragraph grouping.
  const paraGap = 10;
  const blocks: BlockOut[] = [];

  let current: { bbox: BBox; lines: Line[] } | null = null;
  for (const ln of ordered) {
    if (!ln.text) continue;
    if (!current) {
      current = { bbox: ln.bbox, lines: [ln] };
      continue;
    }
    const prev = current.lines[current.lines.length - 1]!;
    const gap = ln.bbox.minY - prev.bbox.maxY;
    if (gap <= paraGap) {
      current.lines.push(ln);
      current.bbox = mergeBbox(current.bbox, ln.bbox);
    } else {
      blocks.push({
        orderInPage: blocks.length,
        bbox: current.bbox,
        text: current.lines.map((l) => l.text).join("\n").trim(),
        blockType: classifyBlock(current.lines.map((l) => l.text).join("\n")),
      });
      current = { bbox: ln.bbox, lines: [ln] };
    }
  }
  if (current) {
    blocks.push({
      orderInPage: blocks.length,
      bbox: current.bbox,
      text: current.lines.map((l) => l.text).join("\n").trim(),
      blockType: classifyBlock(current.lines.map((l) => l.text).join("\n")),
    });
  }

  // Merge very short blocks into the next one.
  const merged: BlockOut[] = [];
  const minLen = 20;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const len = b.text.replace(/\s+/g, " ").trim().length;
    const next = blocks[i + 1];
    if (len < minLen && next) {
      blocks[i + 1] = {
        ...next,
        bbox: mergeBbox(b.bbox, next.bbox),
        text: `${b.text}\n${next.text}`.trim(),
        blockType: classifyBlock(`${b.text}\n${next.text}`),
      };
      continue;
    }
    merged.push({ ...b, orderInPage: merged.length });
  }

  return merged;
}


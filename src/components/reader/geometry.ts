import type { Bounds, ClientBlock, MultiPolygonGeometry, Point } from "@/components/reader/types";

export function geometryBounds(geometry: MultiPolygonGeometry): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of geometry.rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
}

export function blockBounds(block: ClientBlock): Bounds {
  return block.bounds ?? geometryBounds(block.geometry);
}

export function scaleRingPoints(ring: Point[], scale: number): Point[] {
  return ring.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

export function ringToSvgPoints(ring: Point[]): string {
  return ring.map((p) => `${p.x},${p.y}`).join(" ");
}

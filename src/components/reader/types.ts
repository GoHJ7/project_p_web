export type Point = { x: number; y: number };
export type MultiPolygonGeometry = {
  kind: "MULTI_POLYGON";
  version: 1;
  rings: Point[][];
};
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type BlockType = "TEXT" | "CODE" | "MATH";
export type ReaderRenderMode = "reader" | "compare" | "mapping";

export type ClientBlock = {
  id?: string; // DB id (available after upload+fetch)
  anchorId: string;
  pageNumber: number;
  orderInPage: number;
  globalOrder: number;
  geometry: MultiPolygonGeometry;
  bounds?: Bounds;
  text: string;
  blockType: BlockType;
};

export type ProviderId = "openai" | "gemini" | "claude";

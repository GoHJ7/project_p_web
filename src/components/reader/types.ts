export type BBox = { minX: number; minY: number; maxX: number; maxY: number };
export type BlockType = "TEXT" | "CODE" | "MATH";

export type ClientBlock = {
  id?: string; // DB id (available after upload+fetch)
  anchorId: string;
  pageNumber: number;
  orderInPage: number;
  globalOrder: number;
  bbox: BBox;
  text: string;
  blockType: BlockType;
};

export type ProviderId = "openai" | "gemini" | "claude";

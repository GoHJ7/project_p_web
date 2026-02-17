"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import type { ClientBlock } from "@/components/reader/types";

export type TranslationPaneHandle = {
  scrollToAnchor: (anchorId: string) => void;
  scrollBy: (deltaY: number) => void;
};

const VirtuosoScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function VirtuosoScroller(props, ref) {
    return <div {...props} ref={ref} data-testid="translation-scroll" />;
  },
);

type Props = {
  blocks: ClientBlock[];
  translations: Record<string, string | undefined>;
  notes: Record<string, string | undefined>;
  onUserScrollAnchorChange: (anchorId: string) => void;
  onNoteChange: (blockId: string, text: string) => void;
};

export const TranslationPane = forwardRef<TranslationPaneHandle, Props>(
  function TranslationPane(
    { blocks, translations, notes, onUserScrollAnchorChange, onNoteChange },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const [atTopIndex, setAtTopIndex] = useState(0);

    const indexByAnchor = useMemo(() => {
      const m = new Map<string, number>();
      blocks.forEach((b, i) => m.set(b.anchorId, i));
      return m;
    }, [blocks]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToAnchor(anchorId: string) {
          const idx = indexByAnchor.get(anchorId);
          if (idx === undefined) return;
          virtuosoRef.current?.scrollToIndex({ index: idx, align: "start" });
        },
        scrollBy(deltaY: number) {
          virtuosoRef.current?.scrollBy({ top: deltaY });
        },
      }),
      [indexByAnchor],
    );

    useEffect(() => {
      const anchorId = blocks[atTopIndex]?.anchorId;
      if (anchorId) onUserScrollAnchorChange(anchorId);
    }, [atTopIndex, blocks, onUserScrollAnchorChange]);

    return (
      <div className="flex h-full flex-col" data-testid="translation-pane">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="text-xs text-zinc-400">Translations</div>
          <div className="text-xs text-zinc-400">
            {blocks.length ? `${blocks.length} blocks` : ""}
          </div>
        </div>

        <div className="h-full">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: "100%" }}
            components={{ Scroller: VirtuosoScroller }}
            data={blocks}
            rangeChanged={(r) => setAtTopIndex(r.startIndex)}
            itemContent={(_index, b) => {
              const tr = translations[b.anchorId];
              const noteText = b.id ? notes[b.id] : undefined;
              return (
                <div
                  className="border-b border-zinc-800 px-3 py-3"
                  data-testid="translation-card"
                  data-anchor-id={b.anchorId}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className="text-xs font-medium text-zinc-300"
                      data-testid="anchor-id"
                    >
                      {b.anchorId}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      p{b.pageNumber} · {b.blockType}
                    </div>
                  </div>

                  <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
                    {b.text}
                  </div>

                  <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950 p-2 text-sm text-zinc-100">
                    {tr ? (
                      <div className="whitespace-pre-wrap leading-6">{tr}</div>
                    ) : (
                      <div className="text-zinc-500">Not translated yet.</div>
                    )}
                  </div>

                  <div className="mt-3">
                    <textarea
                      className="min-h-14 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-100 placeholder:text-zinc-600"
                      placeholder="Note (saved per anchor)"
                      data-testid="note-textarea"
                      data-block-id={b.id ?? ""}
                      value={noteText ?? ""}
                      disabled={!b.id}
                      onChange={(e) => {
                        if (!b.id) return;
                        onNoteChange(b.id, e.target.value);
                      }}
                    />
                    {!b.id ? (
                      <div className="mt-1 text-[11px] text-zinc-600">
                        Sign in + upload to enable notes syncing.
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }}
          />
        </div>
      </div>
    );
  },
);

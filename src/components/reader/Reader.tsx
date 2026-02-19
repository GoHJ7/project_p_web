"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, set } from "idb-keyval";

import { PdfPane, type PdfPaneHandle } from "@/components/reader/PdfPane";
import {
  TranslatedPdfPane,
  type TranslatedPdfPaneHandle,
} from "@/components/reader/TranslatedPdfPane";
import { GlossaryDrawer } from "@/components/reader/GlossaryDrawer";
import { anchorStrokeColor } from "@/components/reader/mappingColor";
import type {
  ClientBlock,
  ClientImageUnit,
  ProviderId,
  ReaderRenderMode,
} from "@/components/reader/types";
import { useAuth } from "@/lib/auth";

type Extracted = {
  docKey: string;
  pageCount: number;
  pages: { pageNumber: number; width: number; height: number }[];
  blocks: ClientBlock[];
  imageUnits: ClientImageUnit[];
};

type PreprocessProgress = {
  stage?: "extracting" | "persisting";
  currentPage?: number;
  totalPages?: number;
  chunkIndex?: number;
  chunkTotal?: number;
  processedUnits?: number;
  totalUnits?: number;
  message?: string;
};

type PreprocessJobStatus = "queued" | "running" | "completed" | "failed";

type PreprocessDonePayload = {
  documentId: string;
  docKey: string;
  pageCount: number;
  pages: Array<{ pageNumber: number; width: number; height: number }>;
  blocks: Array<{
    id: string;
    anchorId: string;
    pageNumber: number;
    orderInPage: number;
    globalOrder: number;
    geometry: ClientBlock["geometry"];
    bounds?: ClientBlock["bounds"];
    text: string;
    blockType: ClientBlock["blockType"];
  }>;
  imageUnits?: ClientImageUnit[];
};

type MappingLine = {
  anchorId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  active: boolean;
};

const DEFAULT_TRANSLATE_AHEAD = 6;
const TRANSLATION_CACHE_VERSION = "v3";
const DEV_AUTOLOAD_DEFAULT_PDF = import.meta.env.VITE_DEV_AUTOLOAD_DEFAULT_PDF !== "0";
const DEV_DEFAULT_PDF_URL = import.meta.env.VITE_DEV_DEFAULT_PDF_URL || "/dev-default.pdf";
const DEV_MAPPING_DEFAULT_ON = import.meta.env.VITE_MAPPING_MODE_DEFAULT !== "0";
const INITIAL_RENDER_MODE: ReaderRenderMode = DEV_MAPPING_DEFAULT_ON ? "mapping" : "reader";
const AUTO_TRANSLATE_ON_SCROLL = import.meta.env.VITE_AUTO_TRANSLATE_ON_SCROLL !== "0";
const AUTO_TRANSLATE_DEBOUNCE_MS = 120;
const AUTO_TRANSLATE_BATCH_LIMIT = 8;
const AUTO_TRANSLATE_FIRST_BATCH_LIMIT = 3;
const TRANSLATE_WINDOW_BACK = 2;
const TRANSLATE_WINDOW_FORWARD = 10;
const MANUAL_TRANSLATE_BATCH_LIMIT = 40;

export function Reader() {
  const { status } = useAuth();
  const authed = status === "authenticated" || import.meta.env.VITE_DEV_BYPASS_AUTH !== "0";

  const [provider, setProvider] = useState<ProviderId>("openai");
  const [stylePreset, setStylePreset] = useState<"default" | "formal" | "casual">(
    "default",
  );

  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [preprocessProgress, setPreprocessProgress] = useState<PreprocessProgress | null>(
    null,
  );
  const [preprocessJobStatus, setPreprocessJobStatus] = useState<PreprocessJobStatus | null>(
    null,
  );
  const [extracted, setExtracted] = useState<Extracted | null>(null);

  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [blocks, setBlocks] = useState<ClientBlock[]>([]);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [hoverAnchorId, setHoverAnchorId] = useState<string | null>(null);

  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const [translations, setTranslations] = useState<Record<string, string | undefined>>(
    {},
  );
  const [translationFailures, setTranslationFailures] = useState<
    Record<string, string | undefined>
  >({});
  const [pendingAnchorIds, setPendingAnchorIds] = useState<
    Record<string, boolean>
  >({});
  const [translating, setTranslating] = useState(false);
  const translatingRef = useRef(false);

  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const noteSaveTimers = useRef<Map<string, number>>(new Map());
  const noteLoadedFor = useRef<Set<string>>(new Set());

  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [renderMode, setRenderMode] = useState<ReaderRenderMode>(INITIAL_RENDER_MODE);
  const [mappingLines, setMappingLines] = useState<MappingLine[]>([]);
  const defaultPdfTried = useRef(false);
  const autoTranslateQueueRef = useRef<string[]>([]);
  const autoTranslateTimerRef = useRef<number | null>(null);

  const pdfRef = useRef<PdfPaneHandle | null>(null);
  const trPdfRef = useRef<TranslatedPdfPaneHandle | null>(null);
  const mappingGridRef = useRef<HTMLDivElement | null>(null);
  const leftPaneHostRef = useRef<HTMLDivElement | null>(null);
  const rightPaneHostRef = useRef<HTMLDivElement | null>(null);

  const handlePdfMeta = useCallback(
    (m: { docKey: string; pageCount: number }) => {
      // Keep in state even if extract failed; useful for cache keys.
      if (!extracted) return;
      if (m.docKey !== extracted.docKey) return;
    },
    [extracted],
  );

  const syncFrom = useRef<"left" | "right" | null>(null);
  const syncTimer = useRef<number | null>(null);
  const setSync = (src: "left" | "right") => {
    syncFrom.current = src;
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncFrom.current = null;
    }, 150);
  };

  const indexByAnchor = useMemo(() => {
    const m = new Map<string, number>();
    blocks.forEach((b, i) => m.set(b.anchorId, i));
    return m;
  }, [blocks]);

  const activeBlock = useMemo(() => {
    if (!activeAnchorId) return null;
    return blocks.find((b) => b.anchorId === activeAnchorId) ?? null;
  }, [activeAnchorId, blocks]);
  const pendingTranslationCount = useMemo(
    () => Object.keys(pendingAnchorIds).length,
    [pendingAnchorIds],
  );
  const mappingMode = renderMode === "mapping";

  const canTranslate =
    Boolean(documentId) && blocks.length > 0 && !extracting && !uploading && !translating;

  const preprocessLabel = useMemo(() => {
    if (!extracting || !preprocessProgress) return null;
    const stage = preprocessProgress.stage ?? "extracting";
    const chunk =
      preprocessProgress.chunkIndex && preprocessProgress.chunkTotal
        ? `chunk ${preprocessProgress.chunkIndex}/${preprocessProgress.chunkTotal}`
        : null;
    const page =
      preprocessProgress.currentPage && preprocessProgress.totalPages
        ? `page ${preprocessProgress.currentPage}/${preprocessProgress.totalPages}`
        : null;
    const units =
      preprocessProgress.processedUnits && preprocessProgress.totalUnits
        ? `${preprocessProgress.processedUnits}/${preprocessProgress.totalUnits} units`
        : preprocessProgress.processedUnits
          ? `${preprocessProgress.processedUnits} units`
          : null;
    const status = preprocessProgress.message || (stage === "extracting" ? "Extracting" : "Persisting");
    return [status, chunk, page, units].filter(Boolean).join(" · ");
  }, [extracting, preprocessProgress]);

  useEffect(() => {
    translatingRef.current = translating;
  }, [translating]);

  useEffect(() => {
    return () => {
      if (autoTranslateTimerRef.current) {
        window.clearTimeout(autoTranslateTimerRef.current);
        autoTranslateTimerRef.current = null;
      }
    };
  }, []);

  // Prefetch notes around the active anchor (so notes survive reload + re-upload).
  useEffect(() => {
    if (!authed) return;
    if (!activeAnchorId) return;
    if (!blocks.length) return;

    const startIndex = indexByAnchor.get(activeAnchorId) ?? 0;
    const slice = blocks.slice(startIndex, startIndex + DEFAULT_TRANSLATE_AHEAD);
    const blockIds = slice
      .map((b) => b.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const toFetch = blockIds.filter((id) => !noteLoadedFor.current.has(id));
    if (toFetch.length === 0) return;

    let cancelled = false;
    (async () => {
      const entries: Array<{ id: string; text: string | undefined }> = [];
      await Promise.all(
        toFetch.map(async (id) => {
          try {
            const res = await fetch(`/api/blocks/${id}/note`, { method: "GET" });
            if (!res.ok) return;
            const data = (await res.json().catch(() => null)) as
              | { note?: { text?: unknown } | null }
              | null;
            const text =
              typeof data?.note?.text === "string" ? (data!.note!.text as string) : undefined;
            entries.push({ id, text });
          } catch (e) {
            console.error("[note] load failed", e);
          }
        }),
      );

      if (cancelled) return;
      setNotes((prev) => {
        const next = { ...prev };
        for (const e of entries) next[e.id] = e.text;
        return next;
      });
      for (const id of toFetch) noteLoadedFor.current.add(id);
    })();

    return () => {
      cancelled = true;
    };
  }, [authed, activeAnchorId, blocks, indexByAnchor]);

  // Load cached translations for this doc+provider.
  useEffect(() => {
    if (!extracted?.docKey) return;
    (async () => {
      const key = `translations:${TRANSLATION_CACHE_VERSION}:${extracted.docKey}:${provider}`;
      const cached = (await get(key)) as Record<string, string> | undefined;
      if (cached) {
        setTranslations((prev) => ({ ...cached, ...prev }));
      }
    })().catch(() => {});
  }, [extracted?.docKey, provider]);

  useEffect(() => {
    setTranslationFailures({});
    setPendingAnchorIds({});
    autoTranslateQueueRef.current = [];
    if (autoTranslateTimerRef.current) {
      window.clearTimeout(autoTranslateTimerRef.current);
      autoTranslateTimerRef.current = null;
    }
  }, [provider, extracted?.docKey]);

  const handlePickFile = async (file: File) => {
    setUploadError(null);
    setDocumentId(null);
    setExtracted(null);
    setBlocks([]);
    setActiveAnchorId(null);
    setHoverAnchorId(null);
    setTranslations({});
    setTranslationFailures({});
    setPendingAnchorIds({});
    autoTranslateQueueRef.current = [];
    if (autoTranslateTimerRef.current) {
      window.clearTimeout(autoTranslateTimerRef.current);
      autoTranslateTimerRef.current = null;
    }
    setNotes({});
    noteLoadedFor.current.clear();
    setPreprocessProgress(null);
    setPreprocessJobStatus(null);

    const buf = await file.arrayBuffer();
    setPdfData(buf);

    setExtracting(true);
    setUploading(true);
    try {
      const result = await preprocessPdfOnServer(file, (job) => {
        setPreprocessJobStatus(job.status);
        setPreprocessProgress(job.progress ?? null);
      });
      setDocumentId(result.documentId);
      setExtracted({
        docKey: result.docKey,
        pageCount: result.pageCount,
        pages: result.pages,
        blocks: result.blocks,
        imageUnits: result.imageUnits ?? [],
      });
      setBlocks(result.blocks);
      setActiveAnchorId(result.blocks[0]?.anchorId ?? null);
      if (result.blocks.length === 0) {
        setUploadError(
          "PDF opened, but no selectable text was found. This may be a scan or protected content.",
        );
      }
    } catch (e) {
      console.error("[preprocess] failed", e);
      setUploadError(e instanceof Error ? e.message : "PDF preprocess failed.");
      setPreprocessJobStatus("failed");
    } finally {
      setUploading(false);
      setExtracting(false);
    }
  };

  // Dev convenience: auto-load a default PDF on startup/refresh.
  useEffect(() => {
    if (!DEV_AUTOLOAD_DEFAULT_PDF) return;
    if (defaultPdfTried.current) return;
    if (pdfData || extracting || uploading) return;

    defaultPdfTried.current = true;
    (async () => {
      try {
        const res = await fetch(DEV_DEFAULT_PDF_URL, { cache: "no-store" });
        if (!res.ok) return;
        const blob = await res.blob();
        const urlName = DEV_DEFAULT_PDF_URL.split("/").pop() || "dev-default.pdf";
        const file = new File([blob], decodeURIComponent(urlName), {
          type: "application/pdf",
        });
        await handlePickFile(file);
      } catch (e) {
        console.error("[dev-default-pdf] load failed", e);
      }
    })();
  }, [extracting, pdfData, uploading]);

  const collectVisibleAnchorIdsInLeftPane = useCallback((): string[] => {
    const host = leftPaneHostRef.current;
    if (!host) return [];
    const scrollEl = host.querySelector('[data-testid="pdf-scroll"]');
    if (!scrollEl) return [];

    const viewport = scrollEl.getBoundingClientRect();
    const found: Array<{ anchorId: string; top: number }> = [];

    scrollEl.querySelectorAll<HTMLElement>("[data-anchor-id]").forEach((el) => {
      const anchorId = el.dataset.anchorId;
      if (!anchorId) return;
      const r = el.getBoundingClientRect();
      const isVisible = r.bottom >= viewport.top && r.top <= viewport.bottom;
      if (!isVisible) return;
      found.push({ anchorId, top: r.top });
    });

    found.sort((a, b) => a.top - b.top);
    return Array.from(new Set(found.map((v) => v.anchorId)));
  }, []);

  const collectTranslateTargetAnchorIds = useCallback(
    (mode: "manual" | "auto"): string[] => {
      if (!activeAnchorId || blocks.length === 0) return [];

      const startIndex = indexByAnchor.get(activeAnchorId) ?? 0;
      const visibleAnchorIds = collectVisibleAnchorIdsInLeftPane();
      let anchorIds: string[] = [];

      if (visibleAnchorIds.length > 0) {
        const visibleIndexes = visibleAnchorIds
          .map((anchorId) => indexByAnchor.get(anchorId))
          .filter((i): i is number => typeof i === "number")
          .sort((a, b) => a - b);

        if (visibleIndexes.length > 0) {
          const from = Math.max(0, visibleIndexes[0] - TRANSLATE_WINDOW_BACK);
          const to = Math.min(
            blocks.length - 1,
            visibleIndexes[visibleIndexes.length - 1] + TRANSLATE_WINDOW_FORWARD,
          );
          anchorIds = blocks.slice(from, to + 1).map((b) => b.anchorId);
        }
      }

      if (anchorIds.length === 0) {
        const from = Math.max(0, startIndex - TRANSLATE_WINDOW_BACK);
        const to = Math.min(blocks.length - 1, startIndex + TRANSLATE_WINDOW_FORWARD);
        anchorIds = blocks.slice(from, to + 1).map((b) => b.anchorId);
      }

      if (anchorIds.length === 0) {
        const slice = blocks.slice(startIndex, startIndex + DEFAULT_TRANSLATE_AHEAD);
        anchorIds = slice.map((b) => b.anchorId);
      }

      const deduped = Array.from(new Set(anchorIds));
      const unresolved = deduped.filter((anchorId) => {
        const translatedText = translations[anchorId];
        return !(typeof translatedText === "string" && translatedText.trim().length > 0);
      });

      if (mode === "manual") {
        // Manual translate retries failures first, then unresolved, then full range.
        const failed = unresolved.filter((anchorId) => Boolean(translationFailures[anchorId]));
        const fresh = unresolved.filter((anchorId) => !translationFailures[anchorId]);
        const manualOrder = [...failed, ...fresh, ...deduped];
        return Array.from(new Set(manualOrder)).slice(0, MANUAL_TRANSLATE_BATCH_LIMIT);
      }

      const autoTargets = unresolved.filter((anchorId) => !translationFailures[anchorId]);
      return autoTargets.slice(0, AUTO_TRANSLATE_BATCH_LIMIT);
    },
    [
      activeAnchorId,
      blocks,
      collectVisibleAnchorIdsInLeftPane,
      indexByAnchor,
      translationFailures,
      translations,
    ],
  );

  const requestTranslations = useCallback(
    async (anchorIds: string[]) => {
      if (!documentId) {
        setUploadError("Sign in and wait for upload to complete before translating.");
        return;
      }
      const dedupedAnchorIds = Array.from(new Set(anchorIds));
      if (dedupedAnchorIds.length === 0) return;
      if (translatingRef.current) return;

      setPendingAnchorIds((prev) => {
        const next = { ...prev };
        for (const anchorId of dedupedAnchorIds) next[anchorId] = true;
        return next;
      });
      translatingRef.current = true;
      setTranslating(true);
      setUploadError(null);
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            documentId,
            anchorIds: dedupedAnchorIds,
            provider,
            targetLang: "ko",
            stylePreset,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message =
            typeof (data as { message?: unknown }).message === "string"
              ? (data as { message: string }).message
              : undefined;
          const error =
            typeof (data as { error?: unknown }).error === "string"
              ? (data as { error: string }).error
              : undefined;
          const batchError = message ?? error ?? `translate failed (${res.status})`;
          setUploadError(batchError);
          setTranslationFailures((prev) => {
            const next = { ...prev };
            for (const anchorId of dedupedAnchorIds) next[anchorId] = batchError;
            return next;
          });
          return;
        }
        const ts = (data as { translations?: unknown }).translations;
        const list: Array<{ anchorId: string; text: string }> = Array.isArray(ts)
          ? (ts as Array<{ anchorId: string; text: string }>)
          : [];

        const failedRaw = (data as { failures?: unknown }).failures;
        const failures: Array<{ anchorId: string; reason: string }> = Array.isArray(failedRaw)
          ? (failedRaw as Array<{ anchorId?: unknown; reason?: unknown }>).flatMap((f) =>
              typeof f.anchorId === "string" && typeof f.reason === "string"
                ? [{ anchorId: f.anchorId, reason: f.reason }]
                : [],
            )
          : [];

        setTranslationFailures((prev) => {
          const next = { ...prev };
          for (const anchorId of dedupedAnchorIds) delete next[anchorId];
          for (const f of failures) next[f.anchorId] = f.reason;
          return next;
        });

        if (list.length === 0) return;
        let nextMap: Record<string, string | undefined> = {};
        setTranslations((prev) => {
          nextMap = { ...prev };
          for (const t of list) nextMap[t.anchorId] = t.text;
          return nextMap;
        });

        if (extracted?.docKey) {
          const key = `translations:${TRANSLATION_CACHE_VERSION}:${extracted.docKey}:${provider}`;
          await set(key, nextMap);
        }
      } finally {
        setPendingAnchorIds((prev) => {
          if (Object.keys(prev).length === 0) return prev;
          const next = { ...prev };
          for (const anchorId of dedupedAnchorIds) delete next[anchorId];
          return next;
        });
        translatingRef.current = false;
        setTranslating(false);
      }
    },
    [documentId, extracted?.docKey, provider, stylePreset],
  );

  const enqueueAutoTranslateTargets = useCallback(() => {
    const targets = collectTranslateTargetAnchorIds("auto");
    if (targets.length === 0) return;

    const focusAnchorIds = [hoverAnchorId, activeAnchorId].filter(
      (anchorId): anchorId is string => typeof anchorId === "string" && anchorId.length > 0,
    );
    const focusIndexes = focusAnchorIds
      .map((anchorId) => indexByAnchor.get(anchorId))
      .filter((i): i is number => typeof i === "number");
    const scoreByProximity = (anchorId: string) => {
      const idx = indexByAnchor.get(anchorId);
      if (typeof idx !== "number") return Number.MAX_SAFE_INTEGER;
      if (focusIndexes.length === 0) return idx;
      let minDist = Number.MAX_SAFE_INTEGER;
      for (const focusIdx of focusIndexes) {
        const dist = Math.abs(idx - focusIdx);
        if (dist < minDist) minDist = dist;
      }
      return minDist;
    };
    const prioritizedTargets = [...targets].sort(
      (a, b) => scoreByProximity(a) - scoreByProximity(b),
    );

    const q = autoTranslateQueueRef.current;
    const merged = [...prioritizedTargets, ...q];
    const next: string[] = [];
    const seen = new Set<string>();
    for (const anchorId of merged) {
      if (seen.has(anchorId)) continue;
      if (pendingAnchorIds[anchorId]) continue;
      const translatedText = translations[anchorId];
      if (typeof translatedText === "string" && translatedText.trim().length > 0) continue;
      next.push(anchorId);
      seen.add(anchorId);
    }
    autoTranslateQueueRef.current = next;
  }, [
    activeAnchorId,
    collectTranslateTargetAnchorIds,
    hoverAnchorId,
    indexByAnchor,
    pendingAnchorIds,
    translations,
  ]);

  const enqueueTranslateTargets = useCallback(
    (targets: string[], prepend = false) => {
      if (targets.length === 0) return;
      const q = autoTranslateQueueRef.current;
      const merged = prepend ? [...targets, ...q] : [...q, ...targets];
      const next: string[] = [];
      const seen = new Set<string>();
      for (const anchorId of merged) {
        if (seen.has(anchorId)) continue;
        if (pendingAnchorIds[anchorId]) continue;
        const translatedText = translations[anchorId];
        const hasFailure = Boolean(translationFailures[anchorId]);
        if (!hasFailure && typeof translatedText === "string" && translatedText.trim().length > 0) {
          continue;
        }
        next.push(anchorId);
        seen.add(anchorId);
      }
      autoTranslateQueueRef.current = next;
    },
    [pendingAnchorIds, translationFailures, translations],
  );

  const pumpAutoTranslateQueue = useCallback(async () => {
    if (translatingRef.current) return;
    if (!documentId) return;
    const queue = autoTranslateQueueRef.current;
    if (queue.length === 0) return;
    const batchLimit =
      queue.length > AUTO_TRANSLATE_BATCH_LIMIT
        ? AUTO_TRANSLATE_FIRST_BATCH_LIMIT
        : AUTO_TRANSLATE_BATCH_LIMIT;
    const batch = queue.splice(0, batchLimit);
    if (batch.length === 0) return;
    await requestTranslations(batch);
  }, [documentId, requestTranslations]);

  const translateAroundActive = async () => {
    const anchorIds = collectTranslateTargetAnchorIds("manual");
    const hoverFocused =
      hoverAnchorId && hoverAnchorId.length > 0
        ? [hoverAnchorId, ...anchorIds.filter((id) => id !== hoverAnchorId)]
        : anchorIds;
    if (hoverFocused.length === 0) return;
    enqueueTranslateTargets(hoverFocused, true);
    await pumpAutoTranslateQueue();
  };

  const isFiniteNumber = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v);

  const syncAnchorWithOffset = (source: "left" | "right", anchorId: string) => {
    if (source === "left") {
      const sourceTop = pdfRef.current?.getScrollTop();
      const sourceAnchorTop = pdfRef.current?.getScrollTopForAnchor(anchorId);
      const targetAnchorTop = trPdfRef.current?.getScrollTopForAnchor(anchorId);
      if (
        isFiniteNumber(sourceTop) &&
        isFiniteNumber(sourceAnchorTop) &&
        isFiniteNumber(targetAnchorTop)
      ) {
        trPdfRef.current?.scrollToTop(targetAnchorTop + (sourceTop - sourceAnchorTop));
        return;
      }
      trPdfRef.current?.scrollToAnchor(anchorId);
      return;
    }

    const sourceTop = trPdfRef.current?.getScrollTop();
    const sourceAnchorTop = trPdfRef.current?.getScrollTopForAnchor(anchorId);
    const targetAnchorTop = pdfRef.current?.getScrollTopForAnchor(anchorId);
    if (
      isFiniteNumber(sourceTop) &&
      isFiniteNumber(sourceAnchorTop) &&
      isFiniteNumber(targetAnchorTop)
    ) {
      pdfRef.current?.scrollToTop(targetAnchorTop + (sourceTop - sourceAnchorTop));
      return;
    }
    pdfRef.current?.scrollToAnchor(anchorId);
  };

  const onLeftAnchor = (anchorId: string) => {
    setActiveAnchorId(anchorId);
    if (syncFrom.current === "right") return;
    setSync("left");
    syncAnchorWithOffset("left", anchorId);
  };

  const onRightAnchor = (anchorId: string) => {
    setActiveAnchorId(anchorId);
    if (syncFrom.current === "left") return;
    setSync("right");
    syncAnchorWithOffset("right", anchorId);
  };

  useEffect(() => {
    if (!AUTO_TRANSLATE_ON_SCROLL) return;
    if (!canTranslate || !documentId || !activeAnchorId) return;

    if (autoTranslateTimerRef.current) {
      window.clearTimeout(autoTranslateTimerRef.current);
      autoTranslateTimerRef.current = null;
    }

    const timer = window.setTimeout(() => {
      enqueueAutoTranslateTargets();
      void pumpAutoTranslateQueue();
    }, AUTO_TRANSLATE_DEBOUNCE_MS);
    autoTranslateTimerRef.current = timer;

    return () => {
      if (autoTranslateTimerRef.current) {
        window.clearTimeout(autoTranslateTimerRef.current);
        autoTranslateTimerRef.current = null;
      }
    };
  }, [
    activeAnchorId,
    canTranslate,
    documentId,
    enqueueAutoTranslateTargets,
    pumpAutoTranslateQueue,
  ]);

  useEffect(() => {
    if (!AUTO_TRANSLATE_ON_SCROLL) return;
    if (!canTranslate || translating) return;
    if (autoTranslateQueueRef.current.length === 0) return;

    const timer = window.setTimeout(() => {
      void pumpAutoTranslateQueue();
    }, 35);

    return () => window.clearTimeout(timer);
  }, [canTranslate, translating, pumpAutoTranslateQueue]);

  useEffect(() => {
    if (!mappingMode) {
      setMappingLines([]);
      return;
    }

    const gridEl = mappingGridRef.current;
    const leftHost = leftPaneHostRef.current;
    const rightHost = rightPaneHostRef.current;
    if (!gridEl || !leftHost || !rightHost) return;

    const leftScroll = leftHost.querySelector('[data-testid="pdf-scroll"]') as
      | HTMLElement
      | null;
    const rightScroll = rightHost.querySelector('[data-testid="tr-pdf-scroll"]') as
      | HTMLElement
      | null;
    if (!leftScroll || !rightScroll) return;

    let raf = 0;
    const updateLines = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const gridRect = gridEl.getBoundingClientRect();
        const leftViewportRect = leftScroll.getBoundingClientRect();
        const rightViewportRect = rightScroll.getBoundingClientRect();
        const rightByAnchor = new Map<string, { leftX: number; centerY: number }>();
        rightScroll.querySelectorAll<HTMLElement>("[data-anchor-id]").forEach((el) => {
          const anchorId = el.dataset.anchorId;
          if (!anchorId) return;
          const r = el.getBoundingClientRect();
          if (r.bottom < rightViewportRect.top || r.top > rightViewportRect.bottom) return;
          rightByAnchor.set(anchorId, {
            leftX: r.left - gridRect.left + 1,
            centerY: r.top + r.height / 2 - gridRect.top,
          });
        });

        const focusAnchorId = hoverAnchorId ?? activeAnchorId;
        const collected: MappingLine[] = [];
        leftScroll.querySelectorAll<HTMLElement>("[data-anchor-id]").forEach((el) => {
          const anchorId = el.dataset.anchorId;
          if (!anchorId) return;
          const l = el.getBoundingClientRect();
          if (l.bottom < leftViewportRect.top || l.top > leftViewportRect.bottom) return;
          const r = rightByAnchor.get(anchorId);
          if (!r) return;

          collected.push({
            anchorId,
            x1: l.right - gridRect.left - 1,
            y1: l.top + l.height / 2 - gridRect.top,
            x2: r.leftX,
            y2: r.centerY,
            color: anchorStrokeColor(anchorId),
            active: anchorId === focusAnchorId,
          });
        });

        if (focusAnchorId) {
          const focusedLine = collected.find((line) => line.anchorId === focusAnchorId);
          if (focusedLine) {
            setMappingLines([focusedLine]);
            return;
          }
        }

        // Keep the overlay readable by limiting to anchors nearest viewport center.
        const centerY =
          (Math.min(leftViewportRect.bottom, rightViewportRect.bottom) +
            Math.max(leftViewportRect.top, rightViewportRect.top)) /
            2 -
          gridRect.top;
        const limited = collected
          .sort(
            (a, b) =>
              Math.abs((a.y1 + a.y2) / 2 - centerY) -
              Math.abs((b.y1 + b.y2) / 2 - centerY),
          )
          .slice(0, 80)
          .sort((a, b) => a.y1 - b.y1);

        setMappingLines(limited);
      });
    };

    leftScroll.addEventListener("scroll", updateLines, { passive: true });
    rightScroll.addEventListener("scroll", updateLines, { passive: true });
    window.addEventListener("resize", updateLines);
    updateLines();

    return () => {
      cancelAnimationFrame(raf);
      leftScroll.removeEventListener("scroll", updateLines);
      rightScroll.removeEventListener("scroll", updateLines);
      window.removeEventListener("resize", updateLines);
    };
  }, [mappingMode, activeAnchorId, hoverAnchorId, blocks, translations, translationFailures]);

  const onNoteChange = (blockId: string, text: string) => {
    setNotes((prev) => ({ ...prev, [blockId]: text }));

    const prevTimer = noteSaveTimers.current.get(blockId);
    if (prevTimer) window.clearTimeout(prevTimer);

    const t = window.setTimeout(async () => {
      try {
        await fetch(`/api/blocks/${blockId}/note`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch (e) {
        console.error("[note] save failed", e);
      }
    }, 400);
    noteSaveTimers.current.set(blockId, t);
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col gap-3"
      data-testid="reader-root"
      onDragEnter={(e) => {
        // Only activate on file drags (avoid interfering with text drags).
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);

        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        const isPdf =
          f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
          setUploadError("Please drop a PDF file.");
          return;
        }
        void handlePickFile(f);
      }}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-50 rounded-lg border-2 border-amber-400/70 bg-amber-200/10 backdrop-blur-[1px]">
          <div className="flex h-full items-center justify-center p-6">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/90 px-5 py-4 text-center">
              <div className="text-sm font-semibold text-zinc-100">Drop PDF</div>
              <div className="mt-1 text-xs text-zinc-400">
                Drop a PDF to open it locally
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3">
        <label className="inline-flex items-center gap-2 text-xs text-zinc-300">
          <span className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1">
            PDF
          </span>
          <input
            type="file"
            accept="application/pdf"
            data-testid="pdf-input"
            className="text-xs text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-900"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handlePickFile(f);
            }}
          />
        </label>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-950 p-0.5 text-[11px]">
            <button
              className={
                renderMode === "reader"
                  ? "rounded-sm bg-zinc-100 px-2 py-1 font-semibold text-zinc-900"
                  : "rounded-sm px-2 py-1 text-zinc-300 hover:bg-zinc-900"
              }
              onClick={() => setRenderMode("reader")}
            >
              Reader
            </button>
            <button
              className={
                renderMode === "compare"
                  ? "rounded-sm bg-zinc-100 px-2 py-1 font-semibold text-zinc-900"
                  : "rounded-sm px-2 py-1 text-zinc-300 hover:bg-zinc-900"
              }
              onClick={() => setRenderMode("compare")}
            >
              Compare
            </button>
            <button
              className={
                renderMode === "mapping"
                  ? "rounded-sm bg-cyan-500 px-2 py-1 font-semibold text-zinc-950"
                  : "rounded-sm px-2 py-1 text-zinc-300 hover:bg-zinc-900"
              }
              data-testid="mapping-button"
              onClick={() => setRenderMode("mapping")}
            >
              Mapping
            </button>
          </div>

          <select
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs"
            data-testid="provider-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="claude">Claude</option>
          </select>
          <select
            className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs"
            data-testid="style-select"
            value={stylePreset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "default" || v === "formal" || v === "casual") setStylePreset(v);
            }}
          >
            <option value="default">Style: default</option>
            <option value="formal">Style: formal</option>
            <option value="casual">Style: casual</option>
          </select>

          <button
            className="rounded-md bg-amber-300 px-3 py-1.5 text-xs font-semibold text-zinc-900 disabled:opacity-60"
            data-testid="translate-button"
            disabled={!canTranslate}
            onClick={() => void translateAroundActive()}
          >
            {translating ? "Translating..." : "Translate visible"}
          </button>
          {pendingTranslationCount > 0 || translating ? (
            <span className="rounded-md border border-amber-400/50 bg-amber-300/20 px-2 py-1 text-[11px] font-medium text-amber-200">
              {translating ? "translating" : "idle"} · {pendingTranslationCount} pending
            </span>
          ) : null}
          {extracting ? (
            <span className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 py-1 text-[11px] font-medium text-cyan-200">
              {preprocessJobStatus === "running" || preprocessJobStatus === "queued"
                ? "preprocessing"
                : "starting"}{" "}
              · {preprocessProgress?.processedUnits ?? 0} units
            </span>
          ) : null}
          {AUTO_TRANSLATE_ON_SCROLL ? (
            <span className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">
              Auto on scroll
            </span>
          ) : null}

          <button
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
            data-testid="glossary-button"
            disabled={!documentId}
            onClick={() => setGlossaryOpen(true)}
          >
            Glossary
          </button>

          <button
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900"
            data-testid="note-button"
            disabled={!activeBlock?.id}
            onClick={() => setNoteOpen(true)}
          >
            Note
          </button>
        </div>
      </div>

      {uploadError ? (
        <div
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
          data-testid="error-banner"
        >
          {uploadError}
        </div>
      ) : null}
      {extracting && preprocessLabel ? (
        <div className="rounded-lg border border-cyan-900/50 bg-cyan-950/35 px-3 py-2 text-xs text-cyan-200">
          {preprocessLabel}
        </div>
      ) : null}

      <div ref={mappingGridRef} className="relative flex-1 min-h-0">
        <div className="grid h-full min-h-0 grid-cols-2 gap-3">
          <div
            ref={leftPaneHostRef}
            className="h-full min-h-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
          >
            <PdfPane
              ref={pdfRef}
              pdfData={pdfData}
              blocks={blocks}
              docKeyOverride={extracted?.docKey ?? null}
              pageCountOverride={extracted?.pageCount ?? null}
              activeAnchorId={activeAnchorId}
              hoverAnchorId={hoverAnchorId}
              onAnchorHoverChange={setHoverAnchorId}
              onUserScrollAnchorChange={onLeftAnchor}
              onPdfMeta={handlePdfMeta}
              renderMode={renderMode}
            />
          </div>
          <div
            ref={rightPaneHostRef}
            className="h-full min-h-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
          >
            <TranslatedPdfPane
              ref={trPdfRef}
              pdfData={pdfData}
              blocks={blocks}
              imageUnits={extracted?.imageUnits ?? []}
              translations={translations}
              translationFailures={translationFailures}
              pendingAnchorIds={pendingAnchorIds}
              activeAnchorId={activeAnchorId}
              hoverAnchorId={hoverAnchorId}
              onAnchorHoverChange={setHoverAnchorId}
              onUserScrollAnchorChange={onRightAnchor}
              docKey={extracted?.docKey ?? null}
              pageCount={extracted?.pageCount ?? null}
              pageSizes={extracted?.pages ?? []}
              renderMode={renderMode}
            />
          </div>
        </div>

        {mappingMode && mappingLines.length > 0 ? (
          <svg
            className="pointer-events-none absolute inset-0 z-20"
            data-testid="mapping-links"
            preserveAspectRatio="none"
          >
            {mappingLines.map((line) => {
              const lineColor = line.active ? "#f59e0b" : "#22d3ee";
              const bend = Math.max(20, (line.x2 - line.x1) * 0.34);
              const d = `M ${line.x1} ${line.y1} C ${line.x1 + bend} ${line.y1}, ${line.x2 - bend} ${line.y2}, ${line.x2} ${line.y2}`;
              return (
                <g key={`link-${line.anchorId}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke="rgba(255,255,255,0.6)"
                    strokeWidth={line.active ? 5.2 : 3.2}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={lineColor}
                    strokeOpacity={line.active ? 1 : 0.92}
                    strokeWidth={line.active ? 3.2 : 2.2}
                    strokeDasharray={line.active ? undefined : "6 4"}
                  />
                  <circle
                    cx={line.x1}
                    cy={line.y1}
                    r={line.active ? 3 : 2.1}
                    fill={lineColor}
                    fillOpacity={line.active ? 1 : 0.95}
                  />
                  <circle
                    cx={line.x2}
                    cy={line.y2}
                    r={line.active ? 3 : 2.1}
                    fill={lineColor}
                    fillOpacity={line.active ? 1 : 0.95}
                  />
                </g>
              );
            })}
          </svg>
        ) : null}

        {mappingMode && blocks.length > 0 && mappingLines.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
            <div className="rounded-md border border-zinc-700/80 bg-zinc-950/85 px-2 py-1 text-[11px] text-zinc-300">
              No visible mapped units in current viewport
            </div>
          </div>
        ) : null}
      </div>

      <GlossaryDrawer
        open={glossaryOpen}
        onClose={() => setGlossaryOpen(false)}
        documentId={documentId}
      />

      {noteOpen ? (
        <div className="fixed inset-0 z-50" data-testid="note-drawer">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setNoteOpen(false)}
          />
          <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="text-sm font-semibold text-zinc-100">Note</div>
              <button
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-900"
                onClick={() => setNoteOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="flex-1 p-4">
              <div className="text-xs text-zinc-400">
                {activeBlock?.anchorId ?? "No active block"}
              </div>
              <textarea
                className="mt-3 h-[60vh] w-full resize-none rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                placeholder={
                  activeBlock?.id
                    ? "Write a note for this anchor..."
                    : "Sign in + upload to enable notes syncing."
                }
                disabled={!activeBlock?.id}
                value={activeBlock?.id ? notes[activeBlock.id] ?? "" : ""}
                onChange={(e) => {
                  if (!activeBlock?.id) return;
                  onNoteChange(activeBlock.id, e.target.value);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function preprocessPdfOnServer(
  file: File,
  onProgress: (state: { status: PreprocessJobStatus; progress?: PreprocessProgress }) => void,
): Promise<PreprocessDonePayload> {
  const form = new FormData();
  form.set("file", file, file.name);

  const startRes = await fetch("/api/documents/preprocess-jobs", {
    method: "POST",
    body: form,
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(text || "failed to start preprocess job");
  }
  const startData = (await startRes.json()) as { jobId?: string };
  const jobId = startData.jobId;
  if (!jobId) throw new Error("invalid preprocess job response");

  for (let attempt = 0; attempt < 600; attempt++) {
    const pollRes = await fetch(`/api/documents/preprocess-jobs/${jobId}`, {
      cache: "no-store",
    });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      throw new Error(text || "failed to poll preprocess job");
    }
    const data = (await pollRes.json()) as {
      status?: PreprocessJobStatus;
      progress?: PreprocessProgress;
      error?: string;
      result?: PreprocessDonePayload;
    };
    const status = data.status ?? "running";
    onProgress({ status, progress: data.progress });

    if (status === "completed" && data.result) return data.result;
    if (status === "failed") throw new Error(data.error || "preprocess failed");

    await wait(350);
  }

  throw new Error("preprocess timed out");
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

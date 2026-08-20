"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  canvasToBlob,
  cropRegionToCanvas,
  detectImageSegments,
  optimizeImageFile,
  renderOperations,
  renderSegmentationDebugView,
  type EditorOperation,
  type SegmentRegion,
} from "./lib/image";
import {
  buildShareUrl,
  decodeShareDocument,
  encodeShareDocument,
  type ShareDocument,
} from "./lib/share";

type Tool = "resize" | "crop" | "rotate" | "flip" | "segment";
type Toast = { tone: "success" | "error" | "info"; message: string } | null;

const tools: Array<{ id: Tool; index: string; name: string; meta: string }> = [
  { id: "resize", index: "01", name: "调整尺寸", meta: "W × H" },
  { id: "crop", index: "02", name: "裁切比例", meta: "构图" },
  { id: "rotate", index: "03", name: "旋转", meta: "90°" },
  { id: "flip", index: "04", name: "翻转", meta: "镜像" },
  { id: "segment", index: "05", name: "自动分割", meta: "拆分" },
];

const cropPresets = [
  { label: "原比例", value: 0 },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

const resizePresets = [
  { label: "头像", width: 1080, height: 1080 },
  { label: "帖子", width: 1080, height: 1350 },
  { label: "封面", width: 1920, height: 1080 },
];

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "刚刚";
  }
}

function fileBaseName(name: string) {
  return name.replace(/\.[^/.]+$/, "").slice(0, 48) || "未命名画布";
}

export default function ReshapeStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shareInputRef = useRef<HTMLInputElement>(null);
  const renderSequence = useRef(0);

  const [documentState, setDocumentState] = useState<ShareDocument | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>("resize");
  const [author, setAuthor] = useState(() => {
    if (typeof window === "undefined") return "我";
    return window.localStorage.getItem("reshape-author")?.slice(0, 30) || "我";
  });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [resizeWidth, setResizeWidth] = useState(1080);
  const [resizeHeight, setResizeHeight] = useState(1080);
  const [lockRatio, setLockRatio] = useState(true);
  const [cropRatio, setCropRatio] = useState(1);
  const [cropFocus, setCropFocus] = useState({ x: 0.5, y: 0.5 });
  const [isImporting, setIsImporting] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [loadedFromShare, setLoadedFromShare] = useState(false);
  const [segments, setSegments] = useState<SegmentRegion[] | null>(null);
  const [segmentPreviews, setSegmentPreviews] = useState<string[]>([]);
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [segmentDebug, setSegmentDebug] = useState<{ background: string; overlayUrl: string } | null>(null);

  const renderSource = documentState?.sourceDataUrl;
  const renderHistory = documentState?.history;
  const renderCursor = documentState?.cursor ?? 0;

  const currentRatio = dimensions.height ? dimensions.width / dimensions.height : 1;
  const canUndo = Boolean(documentState && documentState.cursor > 0);
  const canRedo = Boolean(documentState && documentState.cursor < documentState.history.length);

  const showToast = useCallback((nextToast: NonNullable<Toast>) => {
    setToast(nextToast);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const payload = params.get("s");
    if (!payload) return;

    decodeShareDocument(payload)
      .then((sharedDocument) => {
        setDocumentState(sharedDocument);
        setLoadedFromShare(true);
        setHistoryOpen(true);
        showToast({ tone: "success", message: "分享快照已打开，可以查看历史或继续编辑。" });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "这个分享链接无法读取。";
        showToast({ tone: "error", message });
      });
  }, [showToast]);

  useEffect(() => {
    if (!renderSource) return;
    const sequence = ++renderSequence.current;
    const nextOperations = renderHistory?.slice(0, renderCursor).map((entry) => entry.operation) ?? [];
    void Promise.resolve().then(() => {
      if (sequence === renderSequence.current) setIsRendering(true);
    });

    renderOperations(renderSource, nextOperations)
      .then((rendered) => {
        if (sequence !== renderSequence.current || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法创建画布。请换用最新版浏览器。");
        context.clearRect(0, 0, rendered.width, rendered.height);
        context.drawImage(rendered.canvas, 0, 0);
        setDimensions({ width: rendered.width, height: rendered.height });
        setResizeWidth(rendered.width);
        setResizeHeight(rendered.height);
      })
      .catch((error: unknown) => {
        if (sequence !== renderSequence.current) return;
        showToast({
          tone: "error",
          message: error instanceof Error ? error.message : "这一步暂时无法渲染。",
        });
      })
      .finally(() => {
        if (sequence === renderSequence.current) setIsRendering(false);
      });
  }, [renderSource, renderHistory, renderCursor, showToast]);

  const resetSegments = useCallback(() => {
    setSegments(null);
    setSegmentPreviews([]);
    setSegmentDebug(null);
  }, []);

  const setCursor = useCallback((cursor: number) => {
    resetSegments();
    setDocumentState((current) => {
      if (!current) return current;
      return { ...current, cursor: Math.max(0, Math.min(cursor, current.history.length)) };
    });
  }, [resetSegments]);

  const undo = useCallback(() => {
    resetSegments();
    setDocumentState((current) => current ? { ...current, cursor: Math.max(0, current.cursor - 1) } : current);
  }, [resetSegments]);

  const redo = useCallback(() => {
    resetSegments();
    setDocumentState((current) => current ? { ...current, cursor: Math.min(current.history.length, current.cursor + 1) } : current);
  }, [resetSegments]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (event.key === "Escape") {
        setShareOpen(false);
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  const importFile = useCallback(async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast({ tone: "error", message: "请选择 JPG、PNG、WEBP 等图片文件。" });
      return;
    }

    setIsImporting(true);
    try {
      const optimized = await optimizeImageFile(file);
      const now = new Date().toISOString();
      resetSegments();
      setDocumentState({
        version: 1,
        id: id("doc"),
        title: fileBaseName(file.name),
        sourceDataUrl: optimized.dataUrl,
        sourceName: file.name.slice(0, 100),
        originalWidth: optimized.originalWidth,
        originalHeight: optimized.originalHeight,
        createdAt: now,
        updatedAt: now,
        history: [],
        cursor: 0,
      });
      setLoadedFromShare(false);
      setHistoryOpen(false);
      setActiveTool("resize");
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      showToast({
        tone: "success",
        message: optimized.originalWidth !== optimized.width || optimized.originalHeight !== optimized.height
          ? `已安全导入，并优化为 ${optimized.width} × ${optimized.height}px。`
          : "图片已导入，开始 reshape 吧。",
      });
    } catch (error) {
      showToast({
        tone: "error",
        message: error instanceof Error ? error.message : "图片导入失败，请换一张再试。",
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [resetSegments, showToast]);

  const applyOperation = useCallback((operation: EditorOperation, label: string) => {
    if (documentState && documentState.cursor >= 100) {
      showToast({ tone: "info", message: "一个快照最多保留 100 步。可以导出当前结果，再作为新图片继续。" });
      return;
    }
    resetSegments();
    setDocumentState((current) => {
      if (!current) return current;
      const entry = {
        id: id("op"),
        label,
        author: author.trim().slice(0, 30) || "访客",
        at: new Date().toISOString(),
        operation,
      };
      const history = [...current.history.slice(0, current.cursor), entry];
      return {
        ...current,
        history,
        cursor: history.length,
        updatedAt: entry.at,
      };
    });
  }, [author, documentState, resetSegments, showToast]);

  const applyResize = () => {
    const width = Math.round(Number(resizeWidth));
    const height = Math.round(Number(resizeHeight));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      showToast({ tone: "error", message: "宽度和高度至少需要 1px。" });
      return;
    }
    if (width > 8192 || height > 8192 || width * height > 32_000_000) {
      showToast({ tone: "error", message: "画布过大。单边不超过 8192px，且总像素不超过 3200 万。" });
      return;
    }
    applyOperation({ kind: "resize", width, height }, `调整尺寸 · ${width} × ${height}`);
  };

  const applyCrop = () => {
    const ratio = cropRatio || currentRatio;
    applyOperation(
      { kind: "crop", aspectRatio: ratio, focusX: cropFocus.x, focusY: cropFocus.y },
      `裁切比例 · ${cropPresets.find((preset) => Math.abs(preset.value - ratio) < 0.001)?.label ?? ratio.toFixed(2)}`,
    );
  };

  const onResizeWidth = (value: number) => {
    setResizeWidth(value);
    if (lockRatio && currentRatio && Number.isFinite(value)) setResizeHeight(Math.max(1, Math.round(value / currentRatio)));
  };

  const onResizeHeight = (value: number) => {
    setResizeHeight(value);
    if (lockRatio && currentRatio && Number.isFinite(value)) setResizeWidth(Math.max(1, Math.round(value * currentRatio)));
  };

  const exportImage = async () => {
    if (!canvasRef.current || !documentState) return;
    try {
      const blob = await canvasToBlob(canvasRef.current, "image/png", 1);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${documentState.title || "reshape"}-${dimensions.width}x${dimensions.height}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast({ tone: "success", message: "PNG 已导出。" });
    } catch (error) {
      showToast({ tone: "error", message: error instanceof Error ? error.message : "导出失败。" });
    }
  };

  useEffect(() => {
    return () => {
      segmentPreviews.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [segmentPreviews]);

  useEffect(() => {
    return () => {
      if (segmentDebug) URL.revokeObjectURL(segmentDebug.overlayUrl);
    };
  }, [segmentDebug]);

  const runSegmentation = useCallback(async () => {
    if (!canvasRef.current) return;
    setIsSegmenting(true);
    setSegmentDebug(null);
    try {
      const regions = detectImageSegments(canvasRef.current);
      if (regions.length === 0) {
        setSegments([]);
        setSegmentPreviews([]);
        showToast({
          tone: "info",
          message: "未检测到可拆分的独立图片。背景越纯色、图片间空隙越明显，识别效果越好。",
        });
        return;
      }

      const previews = await Promise.all(
        regions.map(async (region) => {
          const cropped = cropRegionToCanvas(canvasRef.current!, region);
          const blob = await canvasToBlob(cropped, "image/png", 1);
          return URL.createObjectURL(blob);
        }),
      );
      setSegments(regions);
      setSegmentPreviews(previews);
      showToast({ tone: "success", message: `检测到 ${regions.length} 张独立图片。` });
    } catch (error) {
      showToast({
        tone: "error",
        message: error instanceof Error ? error.message : "自动分割失败，请重试。",
      });
    } finally {
      setIsSegmenting(false);
    }
  }, [showToast]);

  const showSegmentDebug = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const { background, overlayCanvas } = renderSegmentationDebugView(canvasRef.current);
      const blob = await canvasToBlob(overlayCanvas, "image/png", 1);
      const overlayUrl = URL.createObjectURL(blob);
      const backgroundLabel = `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`;
      setSegmentDebug((current) => {
        if (current) URL.revokeObjectURL(current.overlayUrl);
        return { background: backgroundLabel, overlayUrl };
      });
    } catch (error) {
      showToast({
        tone: "error",
        message: error instanceof Error ? error.message : "诊断信息生成失败。",
      });
    }
  }, [showToast]);

  const downloadSegment = useCallback(async (index: number) => {
    if (!canvasRef.current || !segments) return;
    const cropped = cropRegionToCanvas(canvasRef.current, segments[index]);
    const blob = await canvasToBlob(cropped, "image/png", 1);
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${documentState?.title || "reshape"}-part-${index + 1}.png`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [documentState, segments]);

  const downloadAllSegments = useCallback(async () => {
    if (!segments) return;
    for (let index = 0; index < segments.length; index += 1) {
      await downloadSegment(index);
      // Browsers block rapid same-tick downloads; a short gap keeps every file intact.
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
    showToast({ tone: "success", message: `已导出 ${segments.length} 张图片。` });
  }, [downloadSegment, segments, showToast]);

  const openShare = async () => {
    if (!documentState) {
      showToast({ tone: "info", message: "先上传图片，再创建分享快照。" });
      return;
    }
    setShareOpen(true);
    setShareBusy(true);
    setShareUrl("");
    try {
      const snapshot = { ...documentState, updatedAt: new Date().toISOString() };
      const payload = await encodeShareDocument(snapshot);
      setShareUrl(buildShareUrl(payload));
      window.setTimeout(() => shareInputRef.current?.select(), 50);
    } catch (error) {
      showToast({ tone: "error", message: error instanceof Error ? error.message : "分享链接生成失败。" });
      setShareOpen(false);
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast({ tone: "success", message: "分享链接已复制。对方可以浏览历史并继续编辑。" });
    } catch {
      shareInputRef.current?.select();
      showToast({ tone: "info", message: "链接已选中，请手动复制。" });
    }
  };

  const updateAuthor = (value: string) => {
    const next = value.slice(0, 30);
    setAuthor(next);
    window.localStorage.setItem("reshape-author", next);
  };

  const updateTitle = (value: string) => {
    setDocumentState((current) => current ? { ...current, title: value.slice(0, 60) } : current);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    void importFile(event.dataTransfer.files?.[0]);
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => fileInputRef.current?.click()} aria-label="导入新图片">
          <span className="brand-mark">R/</span>
          <span>RE/SHAPE</span>
        </button>

        <div className="topbar-center" aria-label="文档状态">
          {documentState ? (
            <input
              className="title-input"
              value={documentState.title}
              onChange={(event) => updateTitle(event.target.value)}
              aria-label="画布名称"
            />
          ) : <span>未命名画布</span>}
          <span className="saved-state">{loadedFromShare ? "来自分享" : "本地处理"}</span>
        </div>

        <div className="topbar-actions">
          <div className="undo-group" aria-label="历史导航">
            <button type="button" onClick={undo} disabled={!canUndo} aria-label="撤销">↶</button>
            <button type="button" onClick={redo} disabled={!canRedo} aria-label="重做">↷</button>
          </div>
          <button className="mobile-history-button" type="button" onClick={() => setHistoryOpen(true)}>
            历史 {documentState?.history.length ?? 0}
          </button>
          <button className="quiet-button" type="button" onClick={exportImage} disabled={!documentState}>导出</button>
          <button className="share-button" type="button" onClick={openShare} disabled={!documentState}>
            <span>分享快照</span>
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="图片编辑工作台">
        <aside className="tool-panel" aria-label="变形工具">
          <div className="panel-heading">
            <p className="eyebrow">变形工具</p>
            <button className="replace-button" type="button" onClick={() => fileInputRef.current?.click()}>
              {documentState ? "替换图片" : "选择图片"}
            </button>
          </div>

          <nav className="tool-list" aria-label="工具列表">
            {tools.map((tool) => (
              <button
                className={activeTool === tool.id ? "tool-row active" : "tool-row"}
                type="button"
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                aria-pressed={activeTool === tool.id}
              >
                <span className="tool-index">{tool.index}</span>
                <span className="tool-name">{tool.name}</span>
                <span className="tool-meta">{tool.meta}</span>
              </button>
            ))}
          </nav>

          <section className="tool-controls" aria-live="polite">
            {activeTool === "resize" && (
              <>
                <div className="control-title"><strong>目标尺寸</strong><span>PX</span></div>
                <div className="dimension-grid">
                  <label><span>宽度 W</span><input type="number" min="1" max="8192" value={resizeWidth} onChange={(event) => onResizeWidth(Number(event.target.value))} disabled={!documentState} /></label>
                  <button className={lockRatio ? "ratio-lock active" : "ratio-lock"} type="button" onClick={() => setLockRatio((value) => !value)} aria-pressed={lockRatio} aria-label="锁定宽高比">{lockRatio ? "链接" : "独立"}</button>
                  <label><span>高度 H</span><input type="number" min="1" max="8192" value={resizeHeight} onChange={(event) => onResizeHeight(Number(event.target.value))} disabled={!documentState} /></label>
                </div>
                <div className="preset-stack">
                  {resizePresets.map((preset) => <button type="button" key={preset.label} disabled={!documentState} onClick={() => { setResizeWidth(preset.width); setResizeHeight(preset.height); }}>{preset.label}<span>{preset.width}×{preset.height}</span></button>)}
                </div>
                <button className="apply-button" type="button" onClick={applyResize} disabled={!documentState || isRendering}>应用尺寸 <span>↵</span></button>
              </>
            )}

            {activeTool === "crop" && (
              <>
                <div className="control-title"><strong>画面比例</strong><span>非破坏</span></div>
                <div className="ratio-grid">
                  {cropPresets.map((preset) => <button type="button" className={cropRatio === preset.value ? "selected" : ""} key={preset.label} disabled={!documentState} onClick={() => setCropRatio(preset.value)}>{preset.label}</button>)}
                </div>
                <div className="control-title focus-title"><strong>构图焦点</strong><span>九宫格</span></div>
                <div className="focus-grid" aria-label="裁切焦点">
                  {[0, .5, 1].flatMap((y) => [0, .5, 1].map((x) => (
                    <button key={`${x}-${y}`} type="button" disabled={!documentState} className={cropFocus.x === x && cropFocus.y === y ? "selected" : ""} onClick={() => setCropFocus({ x, y })} aria-label={`焦点 ${x}-${y}`} />
                  )))}
                </div>
                <button className="apply-button" type="button" onClick={applyCrop} disabled={!documentState || isRendering}>应用裁切 <span>↵</span></button>
              </>
            )}

            {activeTool === "rotate" && (
              <>
                <div className="control-title"><strong>旋转画布</strong><span>一步一记录</span></div>
                <div className="action-grid">
                  <button type="button" disabled={!documentState} onClick={() => applyOperation({ kind: "rotate", degrees: -90 }, "向左旋转 · 90°")}><b>↶</b><span>向左 90°</span></button>
                  <button type="button" disabled={!documentState} onClick={() => applyOperation({ kind: "rotate", degrees: 90 }, "向右旋转 · 90°")}><b>↷</b><span>向右 90°</span></button>
                  <button type="button" disabled={!documentState} onClick={() => applyOperation({ kind: "rotate", degrees: 180 }, "旋转 · 180°")}><b>↻</b><span>旋转 180°</span></button>
                </div>
              </>
            )}

            {activeTool === "flip" && (
              <>
                <div className="control-title"><strong>镜像翻转</strong><span>即时</span></div>
                <div className="action-grid two">
                  <button type="button" disabled={!documentState} onClick={() => applyOperation({ kind: "flip", axis: "horizontal" }, "水平翻转")}><b>↔</b><span>水平翻转</span></button>
                  <button type="button" disabled={!documentState} onClick={() => applyOperation({ kind: "flip", axis: "vertical" }, "垂直翻转")}><b>↕</b><span>垂直翻转</span></button>
                </div>
              </>
            )}

            {activeTool === "segment" && (
              <>
                <div className="control-title"><strong>自动分割</strong><span>拆分</span></div>
                <p className="segment-hint">
                  适合一张画布里拼了多张照片的情况：背景越纯色、每张照片之间的空隙越明显，识别越准确。分割不会写入编辑历史，可以反复检测。
                </p>
                <button
                  className="apply-button"
                  type="button"
                  onClick={() => void runSegmentation()}
                  disabled={!documentState || isSegmenting}
                >
                  {isSegmenting ? "正在识别…" : "检测独立图片"} <span>→</span>
                </button>

                {segments && segments.length > 0 && (
                  <>
                    <div className="segment-grid">
                      {segments.map((region, index) => (
                        <div className="segment-card" key={`${region.x}-${region.y}-${region.width}-${region.height}`}>
                          {segmentPreviews[index] && (
                            <img src={segmentPreviews[index]} alt={`检测到的第 ${index + 1} 张图片`} />
                          )}
                          <div className="segment-meta">
                            <span>{Math.round(region.width)} × {Math.round(region.height)}</span>
                            <button type="button" onClick={() => void downloadSegment(index)}>下载</button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="apply-button" type="button" onClick={() => void downloadAllSegments()}>
                      全部下载 · {segments.length} 张 <span>↓</span>
                    </button>
                  </>
                )}

                {segments && segments.length === 0 && (
                  <>
                    <p className="segment-empty">未检测到可拆分的独立图片。试试让每张照片之间留出更明显的纯色空白。</p>
                    <button className="quiet-button segment-debug-button" type="button" onClick={() => void showSegmentDebug()}>
                      查看诊断信息
                    </button>
                  </>
                )}

                {segmentDebug && (
                  <div className="segment-debug">
                    <div className="control-title"><strong>诊断信息</strong><span>调试</span></div>
                    <p className="segment-hint">
                      粉色高亮的区域是被识别为「照片内容」的像素，未高亮区域被当作背景/间隙。识别到的背景色：
                      <code>{segmentDebug.background}</code>
                    </p>
                    <img className="segment-debug-image" src={segmentDebug.overlayUrl} alt="自动分割诊断视图：粉色为识别到的照片内容" />
                  </div>
                )}
              </>
            )}
          </section>

          <div className="privacy-note">
            <span className="privacy-dot" />
            <p><strong>编辑时不上传图片</strong><br />创建分享时，链接本身会包含压缩图片和完整历史。</p>
          </div>
        </aside>

        <section
          className={isDragging ? "canvas-area dragging" : "canvas-area"}
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
          onDrop={onDrop}
        >
          <div className="canvas-meta">
            <span>{documentState ? `${documentState.sourceName} / 100%` : "画布 / 100%"}</span>
            <span>{dimensions.width} × {dimensions.height} PX</span>
          </div>

          {!documentState ? (
            <label className="drop-stage">
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => void importFile(event.target.files?.[0])} />
              <span className="upload-orbit" aria-hidden="true"><span>{isImporting ? "…" : "＋"}</span></span>
              <span className="drop-kicker">{isImporting ? "正在优化图片" : "从这里开始"}</span>
              <strong>{isImporting ? "准备你的画布" : "把图片拖到画布"}</strong>
              <span className="drop-copy">或点击选择 JPG、PNG、WEBP · 建议 30MB 以内</span>
            </label>
          ) : (
            <div className="canvas-stage">
              <canvas ref={canvasRef} aria-label={`正在编辑 ${documentState.title}`} />
              {isRendering && <span className="rendering-badge">正在重绘…</span>}
              {isDragging && <div className="drop-overlay"><strong>松开以替换图片</strong><span>当前历史将从新图片重新开始</span></div>}
            </div>
          )}

          <div className="canvas-footer">
            <span>所有处理均在浏览器完成</span>
            <div className="canvas-footer-actions">
              {documentState && <button type="button" onClick={() => fileInputRef.current?.click()}>＋ 新图片</button>}
              <span className="zoom-control">适应画布</span>
            </div>
          </div>
          {documentState && <input className="sr-file" ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => void importFile(event.target.files?.[0])} />}
        </section>

        <aside className={historyOpen ? "history-panel mobile-open" : "history-panel"} aria-label="编辑历史">
          <div className="history-header">
            <div><p className="eyebrow">时间线</p><h2>编辑历史</h2></div>
            <div className="history-header-actions">
              <span className="history-count">{documentState?.history.length ?? 0}</span>
              <button className="history-close" type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭历史">×</button>
            </div>
          </div>

          {!documentState ? (
            <div className="empty-history"><span className="timeline-line" /><span className="timeline-node" /><p>上传图片后，每一步操作都会出现在这里。</p><small>可以回到任意节点；继续编辑会替换该节点之后的步骤。</small></div>
          ) : (
            <div className="history-list">
              <button className={documentState.cursor === 0 ? "history-item current" : "history-item"} type="button" onClick={() => setCursor(0)}>
                <span className="history-node">00</span>
                <span className="history-copy"><strong>导入原图</strong><small>{documentState.originalWidth} × {documentState.originalHeight} · {formatTime(documentState.createdAt)}</small></span>
              </button>
              {documentState.history.map((entry, index) => {
                const cursor = index + 1;
                const isFuture = cursor > documentState.cursor;
                return (
                  <button className={`history-item${cursor === documentState.cursor ? " current" : ""}${isFuture ? " future" : ""}`} type="button" key={entry.id} onClick={() => setCursor(cursor)}>
                    <span className="history-node">{String(cursor).padStart(2, "0")}</span>
                    <span className="history-copy"><strong>{entry.label}</strong><small>{entry.author} · {formatTime(entry.at)}</small></span>
                  </button>
                );
              })}
              {documentState.cursor < documentState.history.length && (
                <div className="branch-note"><strong>正在查看较早版本</strong><span>继续编辑会从这里创建新分支，灰色步骤将被替换。</span></div>
              )}
            </div>
          )}

          <div className="history-footnote"><span>快照链接</span><strong>可浏览 · 可继续编辑</strong></div>
        </aside>
      </section>

      {historyOpen && <button className="mobile-scrim" type="button" aria-label="关闭历史" onClick={() => setHistoryOpen(false)} />}

      {shareOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShareOpen(false); }}>
          <section className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
            <button className="dialog-close" type="button" onClick={() => setShareOpen(false)} aria-label="关闭">×</button>
            <span className="dialog-kicker">共享当前版本</span>
            <h2 id="share-title">把完整编辑过程一起发出去。</h2>
            <p>对方打开链接后，可以查看每一步历史、回到任意节点，并在自己的浏览器里继续编辑。</p>

            <label className="author-field">
              <span>你的署名</span>
              <input value={author} maxLength={30} onChange={(event) => updateAuthor(event.target.value)} placeholder="例如：Timur" />
            </label>

            <label className="share-link-field">
              <span>快照链接</span>
              <div><input ref={shareInputRef} readOnly value={shareBusy ? "正在压缩图片与历史…" : shareUrl} aria-label="分享链接" /><button type="button" onClick={copyShareUrl} disabled={!shareUrl}>复制</button></div>
            </label>

            <div className="share-facts">
              <div><strong>{documentState?.history.length ?? 0}</strong><span>步历史</span></div>
              <div><strong>{shareUrl ? `${Math.max(1, Math.round(shareUrl.length / 1024))} KB` : "—"}</strong><span>链接大小</span></div>
              <div><strong>本地</strong><span>图片处理</span></div>
            </div>
            {shareUrl.length > 1_500_000 && <p className="link-warning">这张图片生成的链接较长，部分聊天工具可能会截断。建议先降低图片尺寸后再分享。</p>}
            <div className="privacy-callout"><span className="privacy-dot" /><p><strong>持链即可访问</strong> 图片和历史被压缩在链接的 <code>#</code> 后面，不会发送给本站服务器；但任何拿到链接的人都能查看。链接无法撤回或设密码，请勿分享敏感图片。</p></div>
          </section>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span>{toast.message}</div>}
    </main>
  );
}

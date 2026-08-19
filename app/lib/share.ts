import type { EditorOperation } from "./image";

export const SHARE_DOCUMENT_VERSION = 1 as const;

export const SHARE_DOCUMENT_LIMITS = {
  historyEntries: 100,
  imageDimension: 32_768,
  sourceDataUrlCharacters: 12 * 1024 * 1024,
  documentIdCharacters: 128,
  titleCharacters: 160,
  sourceNameCharacters: 255,
  historyIdCharacters: 128,
  historyLabelCharacters: 160,
  authorCharacters: 80,
  timestampCharacters: 48,
} as const;

const MAX_JSON_BYTES =
  SHARE_DOCUMENT_LIMITS.sourceDataUrlCharacters + 512 * 1024;
const MAX_PAYLOAD_CHARACTERS = Math.ceil((MAX_JSON_BYTES * 4) / 3) + 16;
const MAX_ASPECT_RATIO = 1_000;

const GZIP_PREFIX = "g.";
const RAW_PREFIX = "j.";
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATA_IMAGE_PATTERN =
  /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

export type ShareDocumentVersion = typeof SHARE_DOCUMENT_VERSION;

export interface ShareHistoryEntry {
  id: string;
  label: string;
  author: string;
  at: string;
  operation: EditorOperation;
}

/** A shorter alias for UI state that stores the shared timeline. */
export type HistoryEntry = ShareHistoryEntry;

export interface ShareDocument {
  version: ShareDocumentVersion;
  id: string;
  title: string;
  sourceDataUrl: string;
  sourceName: string;
  originalWidth: number;
  originalHeight: number;
  createdAt: string;
  updatedAt: string;
  history: ShareHistoryEntry[];
  /** Number of history entries currently applied; ranges from 0 to history.length. */
  cursor: number;
}

export type ShareDocumentErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_COMPRESSION";

export class ShareDocumentError extends Error {
  readonly code: ShareDocumentErrorCode;

  constructor(code: ShareDocumentErrorCode, message: string) {
    super(message);
    this.name = "ShareDocumentError";
    this.code = code;
  }
}

export interface ShareLocationLike {
  href: string;
}

/**
 * Encode a complete editable snapshot. Gzip is used when the browser supports
 * CompressionStream and it makes the link shorter; otherwise the JSON bytes
 * are stored directly. Both forms are base64url-safe.
 */
export async function encodeShareDocument(
  doc: ShareDocument,
): Promise<string> {
  const validated = validateShareDocument(doc, "要分享的快照");
  const jsonBytes = new TextEncoder().encode(JSON.stringify(validated));

  if (jsonBytes.byteLength > MAX_JSON_BYTES) {
    throw invalidDocument("快照过大，请换一张更小的图片后再分享。");
  }

  if (typeof globalThis.CompressionStream !== "undefined") {
    try {
      const compressed = await transformBytes(
        jsonBytes,
        new CompressionStream("gzip"),
        MAX_JSON_BYTES,
      );

      if (compressed.byteLength < jsonBytes.byteLength) {
        return GZIP_PREFIX + bytesToBase64Url(compressed);
      }
    } catch {
      // A few browsers expose CompressionStream but disable gzip. Raw JSON is
      // a deliberate, interoperable fallback rather than a failed share.
    }
  }

  return RAW_PREFIX + bytesToBase64Url(jsonBytes);
}

/** Decode and fully validate an editable snapshot from a URL payload. */
export async function decodeShareDocument(
  payload: string,
): Promise<ShareDocument> {
  if (typeof payload !== "string" || payload.length === 0) {
    throw invalidPayload("分享链接里没有快照内容。");
  }
  if (payload.length > MAX_PAYLOAD_CHARACTERS) {
    throw invalidPayload("分享快照过大，无法安全打开。");
  }

  let encoded: string;
  let compression: "gzip" | "raw";

  if (payload.startsWith(GZIP_PREFIX)) {
    compression = "gzip";
    encoded = payload.slice(GZIP_PREFIX.length);
  } else if (payload.startsWith(RAW_PREFIX)) {
    compression = "raw";
    encoded = payload.slice(RAW_PREFIX.length);
  } else {
    throw invalidPayload("无法识别快照格式，请确认链接完整无缺。");
  }

  let bytes = base64UrlToBytes(encoded);
  if (compression === "gzip") {
    if (typeof globalThis.DecompressionStream === "undefined") {
      throw new ShareDocumentError(
        "UNSUPPORTED_COMPRESSION",
        "当前浏览器无法解压这个分享快照，请升级浏览器后重试。",
      );
    }

    try {
      bytes = await transformBytes(
        bytes,
        new DecompressionStream("gzip"),
        MAX_JSON_BYTES,
      );
    } catch (error) {
      if (error instanceof ShareDocumentError) {
        throw error;
      }
      throw invalidPayload("快照压缩数据已损坏，请重新复制分享链接。");
    }
  } else if (bytes.byteLength > MAX_JSON_BYTES) {
    throw invalidPayload("分享快照过大，无法安全打开。");
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidPayload("快照文字编码已损坏，请重新复制分享链接。");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidPayload("快照内容不是有效的 JSON 数据。");
  }

  return validateShareDocument(parsed, "分享链接中的快照");
}

/**
 * Replace any existing fragment with the encoded snapshot. Passing a small
 * `{ href }` object keeps this helper easy to use in tests and non-window code.
 */
export function buildShareUrl(
  payload: string,
  locationLike?: ShareLocationLike,
): string {
  if (typeof payload !== "string" || payload.length === 0) {
    throw invalidPayload("没有可加入链接的快照内容。");
  }
  if (payload.length > MAX_PAYLOAD_CHARACTERS) {
    throw invalidPayload("分享快照过大，无法生成链接。");
  }

  const href = locationLike?.href ?? getBrowserHref();
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw invalidPayload("当前页面地址无效，无法生成分享链接。");
  }

  url.hash = `s=${payload}`;
  return url.toString();
}

function getBrowserHref(): string {
  if (typeof globalThis.location?.href === "string") {
    return globalThis.location.href;
  }
  throw invalidPayload("当前环境没有页面地址，请传入 locationLike。");
}

function validateShareDocument(
  value: unknown,
  context: string,
): ShareDocument {
  if (!isRecord(value)) {
    throw invalidDocument(`${context}不是一个有效对象。`);
  }

  if (value.version !== SHARE_DOCUMENT_VERSION) {
    throw invalidDocument(
      value.version === undefined
        ? `${context}缺少版本号。`
        : `${context}使用了不支持的版本（${String(value.version)}）。`,
    );
  }

  const historyValue = value.history;
  if (!Array.isArray(historyValue)) {
    throw invalidDocument(`${context}缺少有效的编辑历史。`);
  }
  if (historyValue.length > SHARE_DOCUMENT_LIMITS.historyEntries) {
    throw invalidDocument(
      `编辑历史最多保留 ${SHARE_DOCUMENT_LIMITS.historyEntries} 步。`,
    );
  }

  const history = historyValue.map((entry, index) =>
    validateHistoryEntry(entry, index),
  );
  const historyIds = new Set(history.map((entry) => entry.id));
  if (historyIds.size !== history.length) {
    throw invalidDocument("编辑历史包含重复的记录 ID。");
  }

  const cursor = readInteger(value.cursor, "历史位置", 0, history.length);

  return {
    version: SHARE_DOCUMENT_VERSION,
    id: readString(
      value.id,
      "文档 ID",
      SHARE_DOCUMENT_LIMITS.documentIdCharacters,
    ),
    title: readString(
      value.title,
      "文档标题",
      SHARE_DOCUMENT_LIMITS.titleCharacters,
      true,
    ),
    sourceDataUrl: readSourceDataUrl(value.sourceDataUrl),
    sourceName: readString(
      value.sourceName,
      "源图片文件名",
      SHARE_DOCUMENT_LIMITS.sourceNameCharacters,
    ),
    originalWidth: readInteger(
      value.originalWidth,
      "源图片宽度",
      1,
      SHARE_DOCUMENT_LIMITS.imageDimension,
    ),
    originalHeight: readInteger(
      value.originalHeight,
      "源图片高度",
      1,
      SHARE_DOCUMENT_LIMITS.imageDimension,
    ),
    createdAt: readTimestamp(value.createdAt, "创建时间"),
    updatedAt: readTimestamp(value.updatedAt, "更新时间"),
    history,
    cursor,
  };
}

function validateHistoryEntry(value: unknown, index: number): ShareHistoryEntry {
  const labelPrefix = `第 ${index + 1} 条历史记录`;
  if (!isRecord(value)) {
    throw invalidDocument(`${labelPrefix}不是有效对象。`);
  }

  return {
    id: readString(
      value.id,
      `${labelPrefix}的 ID`,
      SHARE_DOCUMENT_LIMITS.historyIdCharacters,
    ),
    label: readString(
      value.label,
      `${labelPrefix}的标题`,
      SHARE_DOCUMENT_LIMITS.historyLabelCharacters,
    ),
    author: readString(
      value.author,
      `${labelPrefix}的作者`,
      SHARE_DOCUMENT_LIMITS.authorCharacters,
    ),
    at: readTimestamp(value.at, `${labelPrefix}的时间`),
    operation: validateOperation(value.operation, labelPrefix),
  };
}

function validateOperation(value: unknown, labelPrefix: string): EditorOperation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidDocument(`${labelPrefix}缺少有效的图片操作。`);
  }

  switch (value.kind) {
    case "resize":
      return {
        kind: "resize",
        width: readInteger(
          value.width,
          `${labelPrefix}的目标宽度`,
          1,
          SHARE_DOCUMENT_LIMITS.imageDimension,
        ),
        height: readInteger(
          value.height,
          `${labelPrefix}的目标高度`,
          1,
          SHARE_DOCUMENT_LIMITS.imageDimension,
        ),
      };

    case "crop": {
      const operation: EditorOperation = {
        kind: "crop",
        aspectRatio: readFiniteNumber(
          value.aspectRatio,
          `${labelPrefix}的裁切比例`,
          Number.EPSILON,
          MAX_ASPECT_RATIO,
        ),
      };

      if (value.focusX !== undefined) {
        operation.focusX = readFiniteNumber(
          value.focusX,
          `${labelPrefix}的横向焦点`,
          0,
          1,
        );
      }
      if (value.focusY !== undefined) {
        operation.focusY = readFiniteNumber(
          value.focusY,
          `${labelPrefix}的纵向焦点`,
          0,
          1,
        );
      }
      return operation;
    }

    case "rotate":
      if (value.degrees !== 90 && value.degrees !== -90 && value.degrees !== 180) {
        throw invalidDocument(`${labelPrefix}包含不支持的旋转角度。`);
      }
      return { kind: "rotate", degrees: value.degrees };

    case "flip":
      if (value.axis !== "horizontal" && value.axis !== "vertical") {
        throw invalidDocument(`${labelPrefix}包含不支持的翻转方向。`);
      }
      return { kind: "flip", axis: value.axis };

    default:
      throw invalidDocument(`${labelPrefix}包含未知的操作类型。`);
  }
}

function readSourceDataUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidDocument("源图片不是有效的 data:image 地址。");
  }
  if (value.length > SHARE_DOCUMENT_LIMITS.sourceDataUrlCharacters) {
    throw invalidDocument("源图片过大，请换一张更小的图片后再分享。");
  }

  const match = DATA_IMAGE_PATTERN.exec(value);
  const base64 = match?.[2];
  if (!base64 || base64.length % 4 !== 0) {
    throw invalidDocument(
      "源图片必须是有效的 PNG、JPEG 或 WEBP data:image;base64 地址。",
    );
  }

  return value;
}

function readString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw invalidDocument(`${label}必须是文字。`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw invalidDocument(`${label}不能为空。`);
  }
  if (value.length > maximumLength) {
    throw invalidDocument(`${label}不能超过 ${maximumLength} 个字符。`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw invalidDocument(`${label}包含不支持的控制字符。`);
  }
  return value;
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readString(
    value,
    label,
    SHARE_DOCUMENT_LIMITS.timestampCharacters,
  );
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw invalidDocument(`${label}不是有效日期。`);
  }
  return timestamp;
}

function readInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidDocument(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value as number;
}

function readFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidDocument(`${label}必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !BASE64_URL_PATTERN.test(encoded)
  ) {
    throw invalidPayload("快照编码不完整或包含无效字符。");
  }

  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw invalidPayload("快照编码已损坏，请重新复制分享链接。");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function transformBytes(
  input: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  byteLimit: number,
): Promise<Uint8Array> {
  // Copying produces an ArrayBuffer-backed BlobPart even when callers hand us
  // a Uint8Array whose type permits SharedArrayBuffer.
  const source = new Uint8Array(input.byteLength);
  source.set(input);
  const stream = new Blob([source.buffer]).stream().pipeThrough(transform);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > byteLimit) {
        await reader.cancel();
        throw invalidPayload("分享快照解压后过大，已停止读取。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function invalidDocument(message: string): ShareDocumentError {
  return new ShareDocumentError("INVALID_DOCUMENT", `快照内容不合法：${message}`);
}

function invalidPayload(message: string): ShareDocumentError {
  return new ShareDocumentError("INVALID_PAYLOAD", `无法打开分享快照：${message}`);
}

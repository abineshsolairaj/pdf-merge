import { PDFDocument } from 'pdf-lib';

const PDF_MAGIC = '%PDF-';
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES_PER_URL = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

export class PdfMergeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PdfMergeError';
  }
}

export class InvalidPdfFormatError extends PdfMergeError {
  constructor(message = 'Invalid PDF Format', cause?: unknown) {
    super(message, cause);
    this.name = 'InvalidPdfFormatError';
  }
}

export class PdfFetchError extends PdfMergeError {
  constructor(public readonly url: string, message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'PdfFetchError';
  }
}

function stripDataUriPrefix(input: string): string {
  const match = input.match(/^data:application\/pdf;base64,(.*)$/i);
  return match ? match[1] : input;
}

function isLikelyBase64(input: string): boolean {
  if (input.length === 0 || input.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(input);
}

function decodeBase64ToBytes(b64: string, index: number): Uint8Array {
  const cleaned = stripDataUriPrefix(b64).replace(/\s+/g, '');
  if (!isLikelyBase64(cleaned)) {
    throw new InvalidPdfFormatError(
      `Invalid PDF Format: input at index ${index} is not a valid Base64 string`,
    );
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(cleaned, 'base64');
  } catch (err) {
    throw new InvalidPdfFormatError(
      `Invalid PDF Format: failed to decode Base64 at index ${index}`,
      err,
    );
  }
  assertPdfBytes(buffer, `input at index ${index}`);
  return new Uint8Array(buffer);
}

function assertPdfBytes(bytes: Uint8Array | Buffer, label: string): void {
  if (bytes.length < PDF_MAGIC.length) {
    throw new InvalidPdfFormatError(`Invalid PDF Format: ${label} is empty or too small`);
  }
  const header = Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('ascii');
  if (header !== PDF_MAGIC) {
    throw new InvalidPdfFormatError(
      `Invalid PDF Format: ${label} does not start with the %PDF- header`,
    );
  }
}

async function mergePdfBytes(documents: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (let i = 0; i < documents.length; i++) {
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(documents[i], { ignoreEncryption: false });
    } catch (err) {
      throw new InvalidPdfFormatError(
        `Invalid PDF Format: unable to parse PDF at index ${i}`,
        err,
      );
    }
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return merged.save();
}

/**
 * Merges an ordered array of Base64 encoded PDFs into a single Base64 PDF string.
 * The output preserves the input order: index 0 appears first, then 1, then 2, ...
 *
 * @throws {PdfMergeError} when the input array is empty.
 * @throws {InvalidPdfFormatError} when any input is not a decodable PDF.
 */
export async function mergeBase64PDFs(base64Strings: string[]): Promise<string> {
  if (!Array.isArray(base64Strings) || base64Strings.length === 0) {
    throw new PdfMergeError('Input array must contain at least one Base64 PDF string');
  }
  const decoded = base64Strings.map((s, i) => decodeBase64ToBytes(s, i));
  const mergedBytes = await mergePdfBytes(decoded);
  return Buffer.from(mergedBytes).toString('base64');
}

// Removes credentials, query string, and fragment from a URL before it ends up
// in error messages or logs. Signed-URL tokens are commonly placed in the
// query string, so we drop it; userinfo can carry HTTP Basic creds.
function sanitizeUrlForMessages(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}

function validateAndParseUrl(
  url: unknown,
  index: number,
  allowedProtocols: readonly string[],
): URL {
  if (typeof url !== 'string' || url.length === 0) {
    throw new PdfMergeError(`Invalid URL at index ${index}: must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PdfMergeError(`Invalid URL at index ${index}: not a parseable URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new PdfMergeError(
      `Invalid URL at index ${index}: protocol "${parsed.protocol}" is not allowed ` +
        `(allowed: ${allowedProtocols.join(', ')})`,
    );
  }
  return parsed;
}

async function readBodyWithCap(
  response: Response,
  maxBytes: number,
  safeUrl: string,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const declaredNum = Number(declared);
    if (Number.isFinite(declaredNum) && declaredNum > maxBytes) {
      throw new PdfFetchError(
        safeUrl,
        `Failed to fetch PDF from URL: ${safeUrl} (Content-Length ${declaredNum} ` +
          `exceeds maxBytes ${maxBytes})`,
      );
    }
  }

  // No body (e.g. 204) — treat as empty buffer; assertPdfBytes will reject it.
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PdfFetchError(
          safeUrl,
          `Failed to fetch PDF from URL: ${safeUrl} (response body exceeds maxBytes ${maxBytes})`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be released after cancel */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

async function fetchPdf(
  rawUrl: string,
  index: number,
  timeoutMs: number,
  maxBytes: number,
  allowedProtocols: readonly string[],
): Promise<Uint8Array> {
  validateAndParseUrl(rawUrl, index, allowedProtocols);
  const safeUrl = sanitizeUrlForMessages(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(rawUrl, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    throw new PdfFetchError(
      safeUrl,
      aborted
        ? `Failed to fetch PDF from URL: ${safeUrl} (timeout after ${timeoutMs}ms)`
        : `Failed to fetch PDF from URL: ${safeUrl}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new PdfFetchError(
      safeUrl,
      `Failed to fetch PDF from URL: ${safeUrl} (HTTP ${response.status})`,
    );
  }

  // If a redirect chased the request to a disallowed protocol (e.g. data:), reject.
  try {
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (!allowedProtocols.includes(finalUrl.protocol)) {
        throw new PdfFetchError(
          safeUrl,
          `Failed to fetch PDF from URL: ${safeUrl} (redirected to disallowed protocol ` +
            `"${finalUrl.protocol}")`,
        );
      }
    }
  } catch (err) {
    if (err instanceof PdfFetchError) throw err;
    // If parsing response.url fails, fall through — we don't want to block legit responses.
  }

  const buf = await readBodyWithCap(response, maxBytes, safeUrl);
  try {
    assertPdfBytes(buf, `response from ${safeUrl}`);
  } catch (err) {
    if (err instanceof InvalidPdfFormatError) {
      throw new PdfFetchError(
        safeUrl,
        `Failed to fetch PDF from URL: ${safeUrl} (response is not a valid PDF)`,
        err,
      );
    }
    throw err;
  }
  return new Uint8Array(buf);
}

export interface MergePdfUrlsOptions {
  /** Per-request timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Maximum bytes accepted from any single URL response. Defaults to ~100 MiB.
   * Prevents memory exhaustion from hostile or runaway endpoints.
   */
  maxBytesPerUrl?: number;
  /**
   * Protocols accepted when fetching. Defaults to ['http:', 'https:'].
   * Pass a narrower list (e.g. `['https:']`) to harden further.
   */
  allowedProtocols?: readonly string[];
}

/**
 * Fetches PDFs from the given ordered URLs and merges them into a single Base64 PDF string.
 * Downloads happen in parallel; the merge step assembles them in the original index order.
 *
 * Security defaults:
 *  - Only `http:` and `https:` URLs are accepted (blocks `file:`, `data:`, etc.).
 *  - Each response is capped at ~100 MiB (configurable via `maxBytesPerUrl`).
 *  - URLs are sanitized in error messages (credentials and query strings stripped).
 *  - If a redirect lands on a disallowed protocol, the request is rejected.
 *
 * @throws {PdfMergeError} when the input array is empty or a URL fails validation.
 * @throws {PdfFetchError} when a URL cannot be retrieved or does not return a PDF.
 * @throws {InvalidPdfFormatError} when a fetched payload is not a parseable PDF.
 */
export async function mergePdfUrls(
  urls: string[],
  options: MergePdfUrlsOptions = {},
): Promise<string> {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new PdfMergeError('Input array must contain at least one URL');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytesPerUrl ?? DEFAULT_MAX_BYTES_PER_URL;
  const allowedProtocols = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;

  // Validate all URLs up front so we fail fast before opening any sockets.
  urls.forEach((u, i) => validateAndParseUrl(u, i, allowedProtocols));

  const results = await Promise.all(
    urls.map((url, i) => fetchPdf(url, i, timeoutMs, maxBytes, allowedProtocols)),
  );
  const mergedBytes = await mergePdfBytes(results);
  return Buffer.from(mergedBytes).toString('base64');
}

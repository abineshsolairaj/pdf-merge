import { PDFDocument } from 'pdf-lib';

const PDF_MAGIC = '%PDF-';
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

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

async function fetchPdf(url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    throw new PdfFetchError(
      url,
      aborted
        ? `Failed to fetch PDF from URL: ${url} (timeout after ${timeoutMs}ms)`
        : `Failed to fetch PDF from URL: ${url}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new PdfFetchError(
      url,
      `Failed to fetch PDF from URL: ${url} (HTTP ${response.status})`,
    );
  }

  const buf = Buffer.from(await response.arrayBuffer());
  try {
    assertPdfBytes(buf, `response from ${url}`);
  } catch (err) {
    if (err instanceof InvalidPdfFormatError) {
      throw new PdfFetchError(
        url,
        `Failed to fetch PDF from URL: ${url} (response is not a valid PDF)`,
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
}

/**
 * Fetches PDFs from the given ordered URLs and merges them into a single Base64 PDF string.
 * Downloads happen in parallel; the merge step assembles them in the original index order.
 *
 * @throws {PdfMergeError} when the input array is empty.
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

  const results = await Promise.all(urls.map((url) => fetchPdf(url, timeoutMs)));
  const mergedBytes = await mergePdfBytes(results);
  return Buffer.from(mergedBytes).toString('base64');
}

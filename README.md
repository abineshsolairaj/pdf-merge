# pdf-merge

A small TypeScript utility that merges multiple PDF documents into a single PDF,
either from Base64-encoded strings or from URLs. Built on
[`pdf-lib`](https://pdf-lib.js.org/).

## Install

```bash
npm install @abineshsolairaj/pdf-merge
```

Requires Node.js 18+ (uses the global `fetch` and `AbortController`).

### Local development

```bash
npm install
npm run build
npm test
```

## API

### `mergeBase64PDFs(base64Strings: string[]): Promise<string>`

Merges an ordered array of Base64-encoded PDFs and returns the merged document
as a Base64 string. Page order strictly follows the input array order.

- Accepts plain Base64 or `data:application/pdf;base64,…` prefixed strings.
- Throws `InvalidPdfFormatError` if any input is not a decodable PDF.
- Throws `PdfMergeError` if the input array is empty.

```ts
import { mergeBase64PDFs } from '@abineshsolairaj/pdf-merge';

const merged = await mergeBase64PDFs([pdfA_b64, pdfB_b64, pdfC_b64]);
// merged === Base64 string with pages from A, then B, then C
```

### `mergePdfUrls(urls: string[], options?: { timeoutMs?: number }): Promise<string>`

Fetches PDFs from the given URLs in parallel, then merges them in the original
index order and returns the merged document as a Base64 string.

- Default per-request timeout is `5000` ms; override with `options.timeoutMs`.
- Throws `PdfFetchError` (with `.url`) on HTTP errors, timeouts, or non-PDF
  responses.
- Throws `InvalidPdfFormatError` if a fetched payload can't be parsed.
- Throws `PdfMergeError` if the input array is empty.

```ts
import { mergePdfUrls } from '@abineshsolairaj/pdf-merge';

const merged = await mergePdfUrls(
  ['https://example.com/a.pdf', 'https://example.com/b.pdf'],
  { timeoutMs: 8000 },
);
```

## Error types

All errors extend `PdfMergeError`:

| Error                    | When it's thrown                                          |
| ------------------------ | --------------------------------------------------------- |
| `PdfMergeError`          | Generic / empty-input failures.                           |
| `InvalidPdfFormatError`  | Input is not valid Base64 or not a parseable PDF.         |
| `PdfFetchError`          | Network failure, timeout, non-2xx response, or non-PDF body. Exposes the failing `url`. |

## Scripts

```bash
npm run build   # tsc -> dist/
npm test        # ts-node test/pdfMerger.test.ts
```

The test suite spins up a local HTTP server and exercises the TRD acceptance
criteria (ordering, 404 handling, invalid Base64, empty input, timeouts,
non-PDF responses).

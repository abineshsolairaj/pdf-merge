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

### `mergePdfUrls(urls: string[], options?): Promise<string>`

Fetches PDFs from the given URLs in parallel, then merges them in the original
index order and returns the merged document as a Base64 string.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `timeoutMs` | `5000` | Per-request timeout in milliseconds. |
| `maxBytesPerUrl` | `100 * 1024 * 1024` | Maximum bytes accepted from any single response. Caps memory use against hostile or runaway endpoints. |
| `allowedProtocols` | `['http:', 'https:']` | URL protocols allowed. Pass `['https:']` to harden further. |

Throws:

- `PdfMergeError` — empty input, unparseable URL, or disallowed protocol.
- `PdfFetchError` (with `.url`) — HTTP errors, timeouts, oversize responses,
  redirects to disallowed protocols, or non-PDF responses.
- `InvalidPdfFormatError` — fetched payload can't be parsed as a PDF.

```ts
import { mergePdfUrls } from '@abineshsolairaj/pdf-merge';

const merged = await mergePdfUrls(
  ['https://example.com/a.pdf', 'https://example.com/b.pdf'],
  { timeoutMs: 8000, maxBytesPerUrl: 20 * 1024 * 1024, allowedProtocols: ['https:'] },
);
```

## Security model

`mergePdfUrls` is the higher-risk function — it dereferences caller-supplied
URLs. Defaults are chosen to be safe out of the box:

- **Protocol allowlist** — only `http:` and `https:` are accepted; `file:`,
  `data:`, `ftp:`, etc. are rejected before any socket is opened.
- **Response size cap** — `maxBytesPerUrl` is enforced both against the
  declared `Content-Length` and during streaming, so a hostile endpoint that
  serves an unbounded body cannot exhaust the process heap.
- **URL sanitization in errors** — credentials (`user:pass@`) and query
  strings are stripped from URLs before they appear in error messages or on
  the `PdfFetchError.url` property, so signed-URL tokens and HTTP Basic
  passwords don't end up in your logs.
- **Redirect-protocol check** — if a redirect lands on a disallowed protocol,
  the request is rejected.
- **Per-request timeout** — default `5000 ms` via `AbortController`.

What this library does **not** do for you:

- DNS / IP allowlisting (SSRF to internal hosts via `http://10.0.0.1/…` or
  cloud metadata endpoints). If your callers can supply URLs, do the
  IP-range filtering at your network or application layer.
- Concurrency limiting — `Promise.all` is used; pass a sensibly sized array.
- Authentication — caller is responsible for any auth headers.

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

## Publish from GitHub Actions

This repository includes [publish workflow](.github/workflows/publish.yml) to
publish to npm when a GitHub Release is published (or when manually triggered).

1. Create an npm token that can publish with 2FA enabled:
   - npm -> Account Settings -> Access Tokens
   - Use an `Automation` token, or a granular token with package publish
     permission and 2FA bypass.
2. In GitHub repo settings, add secret `NPM_TOKEN` with the token value.
3. Bump package version and push:

```bash
npm version patch
git push --follow-tags
```

4. Create/publish a GitHub Release for the new tag.

The workflow installs dependencies, runs tests, builds, and publishes
`@abineshsolairaj/pdf-merge` to npm.

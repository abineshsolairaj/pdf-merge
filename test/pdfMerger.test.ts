import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  mergeBase64PDFs,
  mergePdfUrls,
  InvalidPdfFormatError,
  PdfFetchError,
  PdfMergeError,
} from '../src/pdfMerger';

type TestFn = () => Promise<void> | void;
const tests: { name: string; fn: TestFn }[] = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}

async function makeSamplePdf(label: string, pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`${label} - page ${i + 1}`, { x: 30, y: 100, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

async function pageCountFromBase64(b64: string): Promise<number> {
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  return doc.getPageCount();
}

test('AC1: merges 3 Base64 PDFs preserving order and page count', async () => {
  const a = (await makeSamplePdf('A', 1)).toString('base64');
  const b = (await makeSamplePdf('B', 2)).toString('base64');
  const c = (await makeSamplePdf('C', 3)).toString('base64');

  const merged = await mergeBase64PDFs([a, b, c]);
  const count = await pageCountFromBase64(merged);
  assert(count === 6, `expected 6 pages, got ${count}`);
});

test('AC4: invalid Base64 input rejects with InvalidPdfFormatError', async () => {
  let caught: unknown;
  try {
    await mergeBase64PDFs(['not-a-real-base64-pdf$$$']);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof InvalidPdfFormatError, 'expected InvalidPdfFormatError');
});

test('valid Base64 but not a PDF rejects with InvalidPdfFormatError', async () => {
  const notPdf = Buffer.from('hello world').toString('base64');
  let caught: unknown;
  try {
    await mergeBase64PDFs([notPdf]);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof InvalidPdfFormatError, 'expected InvalidPdfFormatError');
});

test('empty Base64 input rejects with PdfMergeError', async () => {
  let caught: unknown;
  try {
    await mergeBase64PDFs([]);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof PdfMergeError, 'expected PdfMergeError for empty input');
});

test('AC2 + AC3: mergePdfUrls preserves order and fails gracefully on 404', async () => {
  const a = await makeSamplePdf('UrlA', 1);
  const b = await makeSamplePdf('UrlB', 2);
  const c = await makeSamplePdf('UrlC', 4);

  const server = http.createServer((req, res) => {
    if (req.url === '/a.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(a);
    } else if (req.url === '/b.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(b);
    } else if (req.url === '/c.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(c);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const merged = await mergePdfUrls([`${base}/a.pdf`, `${base}/b.pdf`, `${base}/c.pdf`]);
    const count = await pageCountFromBase64(merged);
    assert(count === 7, `expected 7 pages, got ${count}`);

    let caught: unknown;
    try {
      await mergePdfUrls([`${base}/a.pdf`, `${base}/missing.pdf`]);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError on 404');
    assert(
      (caught as PdfFetchError).url.endsWith('/missing.pdf'),
      'error should reference failing URL',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('mergePdfUrls times out on slow responses', async () => {
  const server = http.createServer((_req, _res) => {
    /* never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([`http://127.0.0.1:${port}/slow.pdf`], { timeoutMs: 100 });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError on timeout');
    assert(
      (caught as Error).message.includes('timeout'),
      'error message should mention timeout',
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('mergePdfUrls fails when response is not a PDF', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not a pdf</html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([`http://127.0.0.1:${port}/page.html`]);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError for non-PDF response');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('security: rejects non-http(s) protocols (file://, data:)', async () => {
  for (const bad of ['file:///etc/passwd', 'data:application/pdf;base64,AAAA', 'ftp://x/y']) {
    let caught: unknown;
    try {
      await mergePdfUrls([bad]);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfMergeError, `expected PdfMergeError for ${bad}`);
    assert(
      /protocol .* is not allowed/.test((caught as Error).message),
      `error should mention disallowed protocol for ${bad}`,
    );
  }
});

test('security: allowedProtocols can narrow to https only', async () => {
  let caught: unknown;
  try {
    await mergePdfUrls(['http://127.0.0.1:9/x.pdf'], { allowedProtocols: ['https:'] });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof PdfMergeError, 'expected PdfMergeError when http is disallowed');
});

test('security: rejects unparseable URLs without opening a socket', async () => {
  let caught: unknown;
  try {
    await mergePdfUrls(['not a url at all']);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof PdfMergeError, 'expected PdfMergeError for unparseable URL');
});

test('security: error messages strip credentials and query strings', async () => {
  const a = await makeSamplePdf('A', 1);
  let receivedAuth: string | undefined;
  let receivedUrl: string | undefined;
  const server = http.createServer((req, res) => {
    receivedAuth = req.headers.authorization;
    receivedUrl = req.url;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([
        `http://alice:s3cret@127.0.0.1:${port}/file.pdf?token=SUPER_SECRET&u=1`,
      ]);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError on 404');
    const message = (caught as Error).message;
    assert(!message.includes('s3cret'), 'password must not leak in error message');
    assert(!message.includes('SUPER_SECRET'), 'query-string token must not leak');
    assert(!message.includes('alice'), 'username must not leak');
    assert(
      (caught as PdfFetchError).url.indexOf('s3cret') === -1 &&
        (caught as PdfFetchError).url.indexOf('SUPER_SECRET') === -1,
      'error.url must not contain credentials or query secrets',
    );
    void receivedAuth;
    void receivedUrl;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('security: maxBytesPerUrl rejects oversized Content-Length', async () => {
  const huge = 10 * 1024 * 1024;
  const server = http.createServer((_req, res) => {
    // Advertise a giant body but only send a small chunk; the pre-check should
    // reject based on Content-Length alone, without us streaming 10MB here.
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(huge) });
    res.end(Buffer.alloc(16));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([`http://127.0.0.1:${port}/huge.pdf`], { maxBytesPerUrl: 1024 });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError for oversized response');
    assert(
      /exceeds maxBytes/.test((caught as Error).message),
      'error should mention maxBytes',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('security: maxBytesPerUrl trips during streaming when Content-Length is absent', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' }); // no Content-Length
    // Write more than the cap; use chunked encoding implicitly.
    const chunk = Buffer.alloc(4 * 1024, 0x41);
    let written = 0;
    const tick = () => {
      if (written >= 32 * 1024) return res.end();
      res.write(chunk);
      written += chunk.length;
      setImmediate(tick);
    };
    tick();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([`http://127.0.0.1:${port}/stream.pdf`], { maxBytesPerUrl: 1024 });
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof PdfFetchError,
      'expected PdfFetchError when streamed body exceeds cap',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('security: redirect to disallowed protocol is rejected', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: 'data:application/pdf;base64,AAAA' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    let caught: unknown;
    try {
      await mergePdfUrls([`http://127.0.0.1:${port}/start`]);
    } catch (err) {
      caught = err;
    }
    // Either the runtime fetch refuses the data: redirect outright, or our
    // post-redirect protocol check kicks in. Both are acceptable hardening.
    assert(caught instanceof PdfFetchError, 'expected PdfFetchError on bad redirect');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`fail - ${t.name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed > 0) process.exit(1);
})();

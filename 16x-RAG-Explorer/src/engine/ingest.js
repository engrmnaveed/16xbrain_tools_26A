// Document ingestion: txt / md / html / csv / json as text; pdf via pdf.js

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function extractPdfText(base64) {
  const pdfjs = await getPdfjs();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(' ') + '\n\n';
  }
  return out;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{3,}/g, '\n\n');
}

let idCounter = 0;
export function makeDocId() {
  return `doc-${Date.now()}-${idCounter++}`;
}

// files: [{ name, type: 'text'|'pdf', data }]
export async function ingestFiles(files) {
  const docs = [];
  for (const f of files) {
    let text = '';
    if (f.type === 'pdf') {
      text = await extractPdfText(f.data);
    } else if (/\.html?$/i.test(f.name)) {
      text = stripHtml(f.data);
    } else {
      text = f.data;
    }
    text = text.replace(/\r\n/g, '\n').trim();
    if (text.length < 20) continue;
    docs.push({ id: makeDocId(), name: f.name, text, chars: text.length });
  }
  return docs;
}

// Adverse media search portal - server
// Runs Google Programmable Search (Custom Search JSON API) queries and exports results to PDF.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// ---- load .env (no extra dependency) ----
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const CSE_ID = process.env.GOOGLE_CSE_ID;

// ---- search terms (from the brief) ----
const CRIME_TERMS = [
  'money laundering', 'terrorist', 'tax evasion', 'trafficking', 'drug', 'arms',
  'smuggling', 'weapon', 'nuclear', 'crime', 'arrest', 'corrupt', 'bribe',
  'embezzlement', 'illegal', 'fraud', 'scam', 'Ponzi', 'sanction',
];
const REGION_TERMS = [
  'Iran', 'North Korea', 'Cuba', 'Syria', 'Crimea', 'Sevastopol', 'Donetsk',
  'Luhansk', 'Kherson', 'Zaporizhzhia',
];

const quote = (t) => (/\s/.test(t) ? `"${t}"` : t);

// Two queries, matching the brief's two AND-groups:
//   "<subject>" AND (crime terms)      and      "<subject>" AND (sanctioned regions)
function buildQueries(subject) {
  const name = `"${subject}"`;
  return [
    {
      category: 'Adverse media (financial crime)',
      terms: CRIME_TERMS,
      q: `${name} (${CRIME_TERMS.map(quote).join(' OR ')})`,
    },
    {
      category: 'Sanctioned jurisdictions',
      terms: REGION_TERMS,
      q: `${name} (${REGION_TERMS.map(quote).join(' OR ')})`,
    },
  ];
}

// ---- Google Custom Search ----
async function googleSearch(q, maxResults) {
  const items = [];
  const limit = Math.min(maxResults, 100); // API returns at most 100 results per query
  for (let start = 1; start <= limit; start += 10) {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.search = new URLSearchParams({
      key: API_KEY,
      cx: CSE_ID,
      q,
      start: String(start),
      num: String(Math.min(10, limit - start + 1)),
    }).toString();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Google API error (${res.status}): ${data.error?.message || 'unknown error'}`);
    }
    if (!data.items || data.items.length === 0) break;
    items.push(...data.items);
    if (data.items.length < 10) break;
  }
  return items;
}

function publishedDate(item) {
  const meta = item.pagemap?.metatags?.[0] || {};
  return meta['article:published_time'] || meta['og:updated_time'] || meta.date || '';
}

async function runSearch(subject, maxResults) {
  const subjectLower = subject.toLowerCase();
  const byLink = new Map();

  for (const { category, terms, q } of buildQueries(subject)) {
    const items = await googleSearch(q, maxResults);
    for (const it of items) {
      const text = `${it.title || ''} ${it.snippet || ''}`;
      const lower = text.toLowerCase();
      const hits = terms.filter((t) => lower.includes(t.toLowerCase()));
      let r = byLink.get(it.link);
      if (!r) {
        r = {
          title: it.title || it.link,
          link: it.link,
          displayLink: it.displayLink || '',
          snippet: it.snippet || '',
          date: publishedDate(it),
          subjectInText: lower.includes(subjectLower),
          categories: [],
          matchedTerms: [],
        };
        byLink.set(it.link, r);
      }
      if (!r.categories.includes(category)) r.categories.push(category);
      for (const h of hits) if (!r.matchedTerms.includes(h)) r.matchedTerms.push(h);
    }
  }

  // Most relevant first: subject named in the title/snippet, then most keyword hits
  return [...byLink.values()].sort(
    (a, b) => Number(b.subjectInText) - Number(a.subjectInText) || b.matchedTerms.length - a.matchedTerms.length
  );
}

// ---- PDF export ----
function buildPdf(res, subject, results) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const slug = subject.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'subject';
  const day = new Date().toISOString().slice(0, 10);

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="adverse-media-${slug}-${day}.pdf"`,
  });

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(18).text('Adverse Media Search Report');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(11).fillColor('#000');
  doc.text(`Subject: ${subject}`);
  doc.text(`Generated: ${stamp}`);
  doc.text(`Results exported: ${results.length}`);
  doc.moveDown(0.8);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.8);

  if (results.length === 0) {
    doc.fontSize(11).text('No results selected.');
  }

  results.forEach((r, i) => {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a4fb3')
      .text(`${i + 1}. ${r.title}`, { link: r.link, underline: false });
    doc.font('Helvetica').fontSize(9).fillColor('#333');
    doc.text(`Source: ${r.displayLink || ''}${r.date ? `   Date: ${r.date.slice(0, 10)}` : ''}`);
    doc.fillColor('#1a4fb3').text(r.link, { link: r.link, underline: true });
    doc.fillColor('#333');
    if (r.snippet) doc.text(r.snippet);
    if (r.matchedTerms && r.matchedTerms.length) {
      doc.fillColor('#8a1c1c').text(`Matched terms: ${r.matchedTerms.join(', ')}`);
    }
    doc.fillColor('#000').moveDown(0.8);
  });

  // page footers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#666')
      .text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 35, { align: 'center', width: 495, lineBreak: false });
  }
  doc.end();
}

// ---- HTTP helpers ----
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// Optional password gate for cloud deployments (HTTP Basic auth).
// Set PORTAL_PASSWORD to enable it. Any username is accepted.
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
function isAuthorized(req) {
  if (!PORTAL_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = Buffer.from(pass), b = Buffer.from(PORTAL_PASSWORD);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Adverse Media Portal"' });
      return res.end('Authentication required');
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX_HTML));
    }

    if (req.method === 'POST' && req.url === '/api/search') {
      if (!API_KEY || !CSE_ID) {
        return sendJson(res, 500, { error: 'Missing GOOGLE_API_KEY or GOOGLE_CSE_ID. See .env.example.' });
      }
      const body = await readJson(req);
      const subject = String(body.subject || '').trim();
      if (subject.length < 2 || subject.length > 120) {
        return sendJson(res, 400, { error: 'Enter a subject name (2-120 characters).' });
      }
      if (/["\\]/.test(subject)) {
        return sendJson(res, 400, { error: 'Remove quote marks and backslashes from the name.' });
      }
      const maxResults = Math.max(10, Math.min(100, Number(body.maxResults) || 30));
      const queries = buildQueries(subject).map(({ category, q }) => ({ category, query: q }));
      const results = await runSearch(subject, maxResults);
      return sendJson(res, 200, { subject, queries, count: results.length, results });
    }

    if (req.method === 'POST' && req.url === '/api/export-pdf') {
      const body = await readJson(req);
      const subject = String(body.subject || 'subject').trim().slice(0, 120);
      const results = (Array.isArray(body.results) ? body.results : []).slice(0, 1000).map((r) => ({
        title: String(r.title || ''),
        link: String(r.link || ''),
        displayLink: String(r.displayLink || ''),
        snippet: String(r.snippet || ''),
        date: String(r.date || ''),
        matchedTerms: Array.isArray(r.matchedTerms) ? r.matchedTerms.map(String) : [],
      }));
      return buildPdf(res, subject, results);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// Local: 127.0.0.1 only. Cloud hosts set HOST=0.0.0.0 so the platform can reach the app.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Adverse media portal running at http://localhost:${PORT}`);
  if (!API_KEY || !CSE_ID) console.log('Warning: GOOGLE_API_KEY / GOOGLE_CSE_ID not set (see .env.example)');
});

module.exports = { buildQueries, CRIME_TERMS, REGION_TERMS };

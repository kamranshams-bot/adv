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

const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// Service account key (full JSON text), set as a secret in Render.
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
// Gemini model used for Google Search grounding on Vertex AI.
const MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-flash';
// Vertex AI location. "global" works for Gemini models with Google Search.
const LOCATION = process.env.VERTEX_LOCATION || 'global';

let sa = null;
try {
  if (SA_JSON) sa = JSON.parse(SA_JSON);
} catch {
  console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
}

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

// ---- Service account -> OAuth access token (JWT bearer flow, no extra packages) ----
let cachedToken = null; // { token, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (!sa) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON. See README.');
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, 'base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Could not get Google access token (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

// ---- Google Search via Gemini grounding on Vertex AI ----
// Returns [{ title, link, displayLink, snippet }] from the sources Google used for the answer.
async function groundedSearch(prompt) {
  const token = await getAccessToken();
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${sa.project_id}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Vertex AI error (${res.status}): ${data.error?.message || 'unknown error'}`);
  }

  const candidate = data.candidates?.[0] || {};
  const meta = candidate.groundingMetadata || {};
  const chunks = meta.groundingChunks || [];
  const supports = meta.groundingSupports || [];

  return chunks
    .map((c, i) => {
      if (!c.web?.uri) return null;
      // Text from the answer that is backed by this source
      const snippet = supports
        .filter((s) => (s.groundingChunkIndices || []).includes(i) && s.segment?.text)
        .map((s) => s.segment.text)
        .join(' ')
        .slice(0, 500);
      const title = c.web.title || c.web.domain || c.web.uri;
      return {
        title,
        link: c.web.uri,
        displayLink: c.web.domain || title,
        snippet,
      };
    })
    .filter(Boolean);
}

function buildPrompt(subject, terms, label) {
  return [
    `Search Google for public news reports, court records, regulatory actions and other sources about "${subject}".`,
    `Only include reports that mention "${subject}" together with one or more of these: ${terms.join(', ')}.`,
    `For each source, briefly state what it says about ${subject}. Cite the sources you used.`,
    `Topic group: ${label}.`,
  ].join(' ');
}

async function runSearch(subject) {
  const subjectLower = subject.toLowerCase();
  const byLink = new Map();

  const groups = [
    { category: 'Adverse media (financial crime)', terms: CRIME_TERMS },
    { category: 'Sanctioned jurisdictions', terms: REGION_TERMS },
  ];

  for (const { category, terms } of groups) {
    const items = await groundedSearch(buildPrompt(subject, terms, category));
    for (const it of items) {
      const text = `${it.title || ''} ${it.snippet || ''}`;
      const lower = text.toLowerCase();
      const hits = terms.filter((t) => lower.includes(t.toLowerCase()));
      let r = byLink.get(it.link);
      if (!r) {
        r = {
          title: it.title,
          link: it.link,
          displayLink: it.displayLink,
          snippet: it.snippet,
          date: '',
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

  const all = [...byLink.values()];
  all.forEach(applyRisk);
  // Highest risk first, then subject named in text, then most keyword hits
  return all.sort(
    (a, b) => b.riskScore - a.riskScore
      || Number(b.subjectInText) - Number(a.subjectInText)
      || b.matchedTerms.length - a.matchedTerms.length
  );
}

// ---- Risk rating ----
// Transparent rule-based score. A reviewer can see the reasons for every rating.
//   Keyword severity (highest hit):  high terms = 3, medium = 2, low = 1
//   Sanctioned region + financial crime keyword in the same result: +2
//   Subject name appears in the title or summary: +2
//   Per result:  score >= 5 -> HIGH,  3-4 -> MEDIUM,  otherwise LOW
//   Region only (no crime keyword): scored as 2 (sanctions exposure)
// Overall (for a whole search or export):
//   HIGH   if 1+ HIGH result names the subject, or 3+ HIGH results
//   MEDIUM if 1+ MEDIUM/HIGH result names the subject, or 2+ MEDIUM/HIGH results
//   LOW    otherwise
const SEVERITY = {
  'money laundering': 3, 'terrorist': 3, 'terrorism': 3, 'trafficking': 3, 'nuclear': 3,
  'arms': 3, 'weapon': 3, 'smuggling': 3, 'ponzi': 3,
  'tax evasion': 2, 'drug': 2, 'embezzlement': 2, 'bribe': 2, 'corrupt': 2,
  'fraud': 2, 'scam': 2, 'sanction': 2,
  'crime': 1, 'arrest': 1, 'illegal': 1,
};
const LEVEL_NAME = { 3: 'high', 2: 'medium', 1: 'low' };

function scoreResult(r) {
  const terms = r.matchedTerms || [];
  const crimeHits = terms.filter((t) => SEVERITY[t.toLowerCase()]);
  const regionHits = terms.filter((t) => !SEVERITY[t.toLowerCase()]);
  const top = Math.max(0, ...crimeHits.map((t) => SEVERITY[t.toLowerCase()]));
  let score = 0;
  const reasons = [];

  if (top) {
    score += top;
    reasons.push(`${LEVEL_NAME[top]}-severity keyword: ${crimeHits.join(', ')}`);
  }
  if (regionHits.length && crimeHits.length) {
    score += 2;
    reasons.push(`sanctioned region with financial crime: ${regionHits.join(', ')}`);
  } else if (regionHits.length) {
    score = Math.max(score, 2);
    reasons.push(`sanctioned region mentioned: ${regionHits.join(', ')}`);
  }
  if (r.subjectInText) {
    score += 2;
    reasons.push('subject named in title or summary');
  }

  const level = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';
  return { level, score, reasons };
}

function applyRisk(r) {
  const { level, score, reasons } = scoreResult(r);
  r.risk = level;
  r.riskScore = score;
  r.riskReasons = reasons;
  return r;
}

function overallRisk(results) {
  const high = results.filter((r) => r.risk === 'high');
  const medOrHigh = results.filter((r) => r.risk === 'high' || r.risk === 'medium');
  const counts = {
    high: high.length,
    medium: results.filter((r) => r.risk === 'medium').length,
    low: results.filter((r) => r.risk === 'low').length,
  };
  let level = 'low';
  if (high.some((r) => r.subjectInText) || high.length >= 3) level = 'high';
  else if (medOrHigh.some((r) => r.subjectInText) || medOrHigh.length >= 2) level = 'medium';
  return { level, counts };
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

  const BLUE = '#1a4fb3';
  const INK = '#1d2330';
  const MUTED = '#5d6675';
  const HIT = '#8a1c1c';

  // ---- Cover block ----
  doc.rect(50, 50, 495, 86).fill('#1a4fb3');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Adverse Media Search Report', 68, 66);
  doc.font('Helvetica').fontSize(11).text(`Subject: ${subject}`, 68, 96);
  const overall = overallRisk(results);
  const RISK_COLOR = { high: '#ffb4b4', medium: '#ffe08a', low: '#b7f0cf' };
  doc.text(`Generated: ${stamp}     Links included: ${results.length}`, 68, 112);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(RISK_COLOR[overall.level])
    .text(`Overall risk: ${overall.level.toUpperCase()}`, 68, 126, { lineBreak: false });
  doc.fillColor('#ffffff').font('Helvetica').fontSize(9)
    .text(`High ${overall.counts.high}  |  Medium ${overall.counts.medium}  |  Low ${overall.counts.low}`, 230, 127, { lineBreak: false });
  doc.y = 150;
  doc.fillColor(INK);

  if (results.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(INK).text('No results selected.');
  }

  // ---- Index of every link in the report ----
  if (results.length) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('All links in this report');
    doc.moveDown(0.4);
    results.forEach((r, i) => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${i + 1}.  `, { continued: true });
      doc.fillColor(BLUE).text(r.link, { link: r.link, underline: true });
    });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d9dde5').stroke();
    doc.moveDown(0.8);
  }

  // ---- Details for each result ----
  results.forEach((r, i) => {
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE)
      .text(`${i + 1}. ${r.title}`, { link: r.link, underline: false });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    doc.text(`Source: ${r.displayLink || ''}${r.date ? `   Date: ${r.date.slice(0, 10)}` : ''}`);
    doc.fillColor(BLUE).text(r.link, { link: r.link, underline: true });
    const RISK_TEXT = { high: '#9b1c1c', medium: '#8a5a00', low: '#0f7b4b' };
    doc.font('Helvetica-Bold').fontSize(9).fillColor(RISK_TEXT[r.risk] || MUTED)
      .text(`Risk: ${(r.risk || 'low').toUpperCase()}`, { continued: true });
    doc.font('Helvetica').fillColor(MUTED).text(`  (${(r.riskReasons || []).join('; ') || 'no keyword match'})`);
    doc.fillColor(INK);
    if (r.snippet) doc.font('Helvetica').fontSize(10).fillColor(INK).text(r.snippet);
    if (r.matchedTerms && r.matchedTerms.length) {
      doc.font('Helvetica').fontSize(9).fillColor(HIT).text(`Matched terms: ${r.matchedTerms.join(', ')}`);
    }
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eceff4').stroke();
    doc.moveDown(0.6);
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
      if (!sa) {
        return sendJson(res, 500, { error: 'Missing GOOGLE_SERVICE_ACCOUNT_JSON. See README.' });
      }
      const body = await readJson(req);
      const subject = String(body.subject || '').trim();
      if (subject.length < 2 || subject.length > 120) {
        return sendJson(res, 400, { error: 'Enter a subject name (2-120 characters).' });
      }
      if (/["\\]/.test(subject)) {
        return sendJson(res, 400, { error: 'Remove quote marks and backslashes from the name.' });
      }
      const queries = buildQueries(subject).map(({ category, terms }) => ({
        category,
        query: buildPrompt(subject, terms, category),
      }));
      const results = await runSearch(subject);
      return sendJson(res, 200, {
        subject,
        queries,
        count: results.length,
        overall: overallRisk(results),
        results,
      });
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
        subjectInText: Boolean(r.subjectInText),
        categories: Array.isArray(r.categories) ? r.categories.map(String) : [],
      })).map(applyRisk);
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
// Start the server only when run directly (not when required by tests)
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Adverse media portal running at http://localhost:${PORT}`);
    if (!sa) console.log('Warning: GOOGLE_SERVICE_ACCOUNT_JSON not set (see .env.example)');
  });
}

module.exports = { buildQueries, CRIME_TERMS, REGION_TERMS, scoreResult, overallRisk };

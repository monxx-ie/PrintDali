// PrintDali local server — no extra packages needed, just Node.js.
// Run:  node server.js   (or double-click START-PrintDali.bat on Windows)
// Then open the address it prints on your laptop and on phones on the same Wi-Fi.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

// ---------- Settings (change to match real shop prices) ----------
const CONFIG = {
  pricePerPage: { bw: 2, color: 5 }, // pesos per printed page
  longPaperExtra: 1,                 // extra per page for long bond
  serviceFee: 3,                     // PrintDali fee per order
  shops: ['Shop A, near gate', 'Shop B, CCS building'],
  papers: ['Short', 'A4', 'Long'],
};
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB per file

// ---------- Folders and saved data ----------
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA, 'orders.json');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const newSession = () => crypto.randomBytes(6).toString('hex');
let db = { session: newSession(), seq: 0, orders: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  broadcast();
}

// ---------- Live updates (Server-Sent Events) ----------
const clients = new Set();
function snapshot() { return JSON.stringify({ session: db.session, orders: db.orders }); }
function broadcast() {
  const msg = `data: ${snapshot()}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- Helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('File is too big (max 25 MB).'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function serveFile(res, baseDir, relPath, download) {
  const full = path.normalize(path.join(baseDir, relPath));
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' };
    if (download) headers['Content-Disposition'] = 'inline';
    res.writeHead(200, headers);
    res.end(data);
  });
}
const safeName = n => String(n).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || lo));
function priceFor({ pages, copies, color, paper }) {
  const perPage = CONFIG.pricePerPage[color] + (paper === 'Long' ? CONFIG.longPaperExtra : 0);
  const printing = pages * copies * perPage;
  return { printing, fee: CONFIG.serviceFee, total: printing + CONFIG.serviceFee };
}
const STATUSES = ['waiting', 'printing', 'ready', 'picked'];

// ---------- Routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/config' && req.method === 'GET') return json(res, 200, { ...CONFIG, session: db.session });

  if (p === '/api/orders' && req.method === 'GET') return json(res, 200, { session: db.session, orders: db.orders });

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${snapshot()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // New order: the file is the request body, order details are in the X-Order-Info header.
  if (p === '/api/orders' && req.method === 'POST') {
    let info;
    try { info = JSON.parse(decodeURIComponent(req.headers['x-order-info'] || '')); } catch { return json(res, 400, { error: 'Missing order details.' }); }
    const fileName = String(info.fileName || '').slice(0, 200);
    if (!/\.(pdf|docx?)$/i.test(fileName)) return json(res, 400, { error: 'Only PDF or Word files are allowed.' });
    const order = {
      fileName,
      pages: clampInt(info.pages, 1, 500),
      copies: clampInt(info.copies, 1, 50),
      color: info.color === 'color' ? 'color' : 'bw',
      paper: CONFIG.papers.includes(info.paper) ? info.paper : CONFIG.papers[0],
      shop: CONFIG.shops.includes(info.shop) ? info.shop : CONFIG.shops[0],
    };
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) return json(res, 400, { error: 'The file is empty.' });
    db.seq += 1;
    const code = 'A-' + String(db.seq).padStart(3, '0');
    const stored = `${code}-${safeName(fileName)}`;
    fs.writeFileSync(path.join(UPLOADS, stored), body);
    const now = Date.now();
    const full = { code, ...order, ...priceFor(order), fileSize: body.length, fileUrl: '/uploads/' + encodeURIComponent(stored), status: 'waiting', createdAt: now, updatedAt: now };
    db.orders.push(full);
    save();
    console.log(`New order #${code}: ${fileName} (${order.pages} pg x ${order.copies}) at ${order.shop}`);
    return json(res, 201, full);
  }

  const m = p.match(/^\/api\/orders\/(A-\d+)$/);
  if (m && req.method === 'PATCH') {
    const o = db.orders.find(x => x.code === m[1]);
    if (!o) return json(res, 404, { error: 'Order not found.' });
    let body;
    try { body = JSON.parse((await readBody(req, 10000)).toString() || '{}'); } catch { return json(res, 400, { error: 'Bad request.' }); }
    if (!STATUSES.includes(body.status)) return json(res, 400, { error: 'Unknown status.' });
    o.status = body.status; o.updatedAt = Date.now();
    save();
    console.log(`Order #${o.code} is now: ${o.status}`);
    return json(res, 200, o);
  }

  if (p === '/api/orders' && req.method === 'DELETE') {
    for (const f of fs.readdirSync(UPLOADS)) fs.rmSync(path.join(UPLOADS, f), { force: true });
    db = { session: newSession(), seq: 0, orders: [] };
    save();
    console.log('Demo reset: all orders deleted.');
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/uploads/') && req.method === 'GET') return serveFile(res, UPLOADS, p.slice('/uploads/'.length), true);

  if (req.method === 'GET') return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p.slice(1));

  json(res, 404, { error: 'Not found.' });
}

http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error.' });
    else res.end();
  });
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  PrintDali is running!\n');
  console.log(`  On this laptop:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  On phones (same Wi-Fi):  http://${ip}:${PORT}`));
  console.log('\n  Print shop view: add  #shop  to the end of the address.');
  console.log('  Keep this window open. Press Ctrl + C to stop.\n');
});

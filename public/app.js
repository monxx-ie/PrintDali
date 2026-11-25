/* PrintDali — front end.
 * Talks to server.js: orders are saved on the laptop running the server, so
 * phones (students) and the laptop (print shop) share the same orders live.
 * Payment is a fake GCash screen: no real money is charged.
 */

// ---------- State ----------
let CONFIG = null;          // prices, shops, papers (from the server)
let orders = [];            // all orders (kept live by the server)
const lastStatus = {};      // to detect when an order becomes "ready"

// This phone's own orders (so each phone only sees its own in "My orders")
const myKey = () => `printdali.myOrders.${CONFIG.session}`;
function myCodes() {
  try { return JSON.parse(localStorage.getItem(myKey())) || []; } catch { return []; }
}
function addMyCode(code) {
  const list = myCodes(); list.push(code);
  try { localStorage.setItem(myKey(), JSON.stringify(list)); } catch {}
}

// ---------- Server calls ----------
async function api(method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}
const getOrder = code => orders.find(o => o.code === code);

// How many orders are before this one in the same shop's line
// (everything being printed now + waiting orders placed earlier).
function aheadOf(o) {
  return orders.filter(x => x.shop === o.shop && x.code !== o.code &&
    (x.status === 'printing' || (x.status === 'waiting' && x.createdAt < o.createdAt))).length;
}
function lineText(o) {
  const n = aheadOf(o);
  return n === 0 ? "You're next in line!" : `${n} order${n > 1 ? 's' : ''} ahead of you`;
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ---------- Helpers ----------
const app = document.getElementById('app');
const peso = n => '₱' + n.toLocaleString('en-PH');
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtTime(t) {
  return new Date(t).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
}
const STATUS = {
  waiting: { label: 'Waiting', title: 'Order received', note: 'The shop will start printing soon.' },
  printing: { label: 'Printing', title: 'Printing now', note: 'Almost there. We will alert you when it is ready.' },
  ready: { label: 'Ready', title: 'Ready for pickup', note: 'Show this order number at the counter.' },
  picked: { label: 'Picked up', title: 'Picked up', note: 'Thanks for using PrintDali!' },
};
const pill = s => `<span class="pill pill-${s}">${STATUS[s].label}</span>`;

function priceFor({ pages, copies, color, paper }) {
  const perPage = CONFIG.pricePerPage[color] + (paper === 'Long' ? CONFIG.longPaperExtra : 0);
  const printing = pages * copies * perPage;
  return { perPage, printing, fee: CONFIG.serviceFee, total: printing + CONFIG.serviceFee };
}

// Count pages of a PDF without any library (works for most normal PDFs).
async function countPdfPages(file) {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder('latin1').decode(buf);
  const matches = text.match(/\/Type\s*\/Page(?!s)/g);
  return matches ? matches.length : 0;
}

// Small message. sticky = stays until the user taps OK.
function toast(msg, sticky = false) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${sticky ? '<button type="button" class="toast-ok">OK</button>' : ''}`;
  t.classList.toggle('sticky', sticky);
  t.hidden = false;
  clearTimeout(toast.timer);
  if (sticky) {
    t.querySelector('.toast-ok').onclick = () => { t.hidden = true; document.title = 'PrintDali'; };
  } else {
    toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
  }
}

// "Ready for pickup" alert: stays on screen, changes the tab title,
// and shows a system notification if the browser allows it.
function readyAlert(o) {
  const msg = `Your print is ready! Pick up #${o.code} at ${o.shop}.`;
  toast(msg, true);
  document.title = '(Ready!) PrintDali';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('PrintDali: Ready for pickup', { body: msg }); } catch {}
  }
}
function askNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// ---------- Router ----------
const currentView = () => (location.hash.replace('#', '') || 'student').split('/')[0];
function route() {
  const [view, arg] = (location.hash.replace('#', '') || 'student').split('/');
  document.querySelectorAll('.viewswitch a').forEach(a => {
    a.classList.toggle('active', a.dataset.view === (view === 'shop' ? 'shop' : 'student'));
  });
  app.classList.toggle('wide', view === 'shop');
  if (view === 'shop') return renderShop();
  if (view === 'new') return renderNewOrder();
  if (view === 'order' && arg) return renderOrder(arg);
  return renderStudentHome();
}
window.addEventListener('hashchange', route);

// ---------- Live updates from the server ----------
function applySnapshot(snap) {
  if (snap.session !== CONFIG.session) {          // the shop pressed "Reset demo"
    CONFIG.session = snap.session;
    Object.keys(lastStatus).forEach(k => delete lastStatus[k]);
  }
  orders = snap.orders;
  const mine = new Set(myCodes());
  const view = currentView();
  orders.forEach(o => {
    if (view !== 'shop' && mine.has(o.code) && o.status === 'ready' && lastStatus[o.code] && lastStatus[o.code] !== 'ready') {
      readyAlert(o);
    }
    lastStatus[o.code] = o.status;
  });
  // Don't redraw while the user is filling the form, paying, or confirming a reset.
  const busy = view === 'new' || document.querySelector('.backdrop') || document.querySelector('#confirm .card');
  if (!busy) route();
}
function connectLive() {
  const es = new EventSource('/api/events');
  es.onmessage = e => { try { applySnapshot(JSON.parse(e.data)); } catch {} };
  // EventSource reconnects by itself if the Wi-Fi drops for a moment.
}

// ---------- Student: home ----------
function renderStudentHome() {
  const mine = new Set(myCodes());
  const list = orders.filter(o => mine.has(o.code)).reverse();
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow" style="color:var(--yellow)">PrintDali</p>
      <h1>Print ahead. Skip the pila.</h1>
      <p>Upload your file, pay online, and pick it up when it's ready.</p>
      <a class="btn btn-primary" href="#new">New print order</a>
    </section>
    <section class="card">
      <h2 style="font-size:20px">My orders</h2>
      ${list.length ? list.map(o => `
        <a class="order-row" href="#order/${o.code}">
          <div class="meta">
            <p class="code">#${o.code}</p>
            <p class="small muted">${esc(o.fileName)} · ${peso(o.total)}</p>
            ${o.status === 'waiting' ? `<p class="small" style="font-weight:700">${lineText(o)}</p>` : ''}
          </div>
          ${pill(o.status)}
        </a>`).join('') : `<p class="empty">No orders yet. Tap "New print order" to start.</p>`}
    </section>`;
}

// ---------- Student: new order ----------
function renderNewOrder() {
  const P = CONFIG.pricePerPage;
  const form = { file: null, pages: 1, copies: 1, color: 'bw', paper: CONFIG.papers[0], shop: CONFIG.shops[0] };

  app.innerHTML = `
    <a class="linkback" href="#student">← Back</a>
    <h1 style="font-size:26px">New print order</h1>

    <section class="card">
      <div class="field">
        <span class="label">1. Your file</span>
        <label class="dropzone" id="drop" for="file">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#D14A22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/></svg>
          <strong>Tap to choose a file</strong>
          <span class="small muted">PDF or Word (.docx), up to 25 MB</span>
        </label>
        <input id="file" type="file" accept=".pdf,.doc,.docx,application/pdf" hidden>
        <div id="filechip"></div>
      </div>
      <div class="field">
        <label for="pages">Number of pages</label>
        <input class="input" id="pages" type="number" min="1" max="500" value="1" inputmode="numeric">
        <p class="small muted" id="pageshint">Enter how many pages your file has.</p>
      </div>
    </section>

    <section class="card">
      <span class="label" style="font-weight:600;font-size:14px">2. Print options</span>
      <div class="field">
        <span class="label" id="colorlbl">Color</span>
        <div class="segmented" role="radiogroup" aria-labelledby="colorlbl">
          <input type="radio" name="color" id="c-bw" value="bw" checked><label for="c-bw">B&amp;W · ${peso(P.bw)}/page</label>
          <input type="radio" name="color" id="c-color" value="color"><label for="c-color">Color · ${peso(P.color)}/page</label>
        </div>
      </div>
      <div class="field">
        <span class="label" id="paperlbl">Paper size</span>
        <div class="segmented" role="radiogroup" aria-labelledby="paperlbl">
          ${CONFIG.papers.map((p, i) => `<input type="radio" name="paper" id="p-${esc(p)}" value="${esc(p)}" ${i === 0 ? 'checked' : ''}><label for="p-${esc(p)}">${esc(p)}</label>`).join('')}
        </div>
      </div>
      <div class="field">
        <span class="label" id="copieslbl">Copies</span>
        <div class="stepper" aria-labelledby="copieslbl">
          <button type="button" id="minus" aria-label="Fewer copies">−</button>
          <output id="copies">1</output>
          <button type="button" id="plus" aria-label="More copies">+</button>
        </div>
      </div>
      <div class="field">
        <label for="shop">Pick-up shop</label>
        <select class="input" id="shop">${CONFIG.shops.map(s => `<option>${esc(s)}</option>`).join('')}</select>
      </div>
    </section>

    <section class="card">
      <span class="label" style="font-weight:600;font-size:14px">3. Pay</span>
      <div class="summary" id="summary"></div>
      <button class="btn btn-primary btn-block" id="pay" disabled>Choose a file first</button>
    </section>`;

  const $ = id => document.getElementById(id);
  const fileInput = $('file'), drop = $('drop');

  function refresh() {
    const p = priceFor(form);
    $('summary').innerHTML = `
      <div class="line"><span>${form.pages} page${form.pages > 1 ? 's' : ''} × ${form.copies} cop${form.copies > 1 ? 'ies' : 'y'} × ${peso(p.perPage)}</span><span>${peso(p.printing)}</span></div>
      <div class="line"><span>PrintDali service fee</span><span>${peso(p.fee)}</span></div>
      <div class="line total"><span>Total</span><span>${peso(p.total)}</span></div>`;
    const pay = $('pay');
    pay.disabled = !form.file;
    pay.textContent = form.file ? `Pay ${peso(p.total)} with GCash` : 'Choose a file first';
  }

  async function setFile(file) {
    if (!file) return;
    if (!/\.(pdf|docx?)$/i.test(file.name)) { toast('Please choose a PDF or Word file.'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('That file is too big (max 25 MB).'); return; }
    form.file = file;
    $('filechip').innerHTML = `
      <div class="filechip">
        <svg width="28" height="32" viewBox="0 0 40 46" aria-hidden="true"><path d="M4 4h22l10 10v28H4z" fill="#F5C842"/><path d="M26 4v10h10" fill="#E0B232"/></svg>
        <div class="meta"><p>${esc(file.name)}</p><p class="small muted">${fmtSize(file.size)}</p></div>
        <button type="button" class="btn btn-ghost btn-small" id="change">Change</button>
      </div>`;
    $('change').onclick = () => fileInput.click();
    if (/\.pdf$/i.test(file.name)) {
      const n = await countPdfPages(file);
      if (n > 0) {
        form.pages = n;
        $('pages').value = n;
        $('pageshint').textContent = `We counted ${n} page${n > 1 ? 's' : ''} in your PDF.`;
      }
    } else {
      $('pageshint').textContent = 'Word file: enter the number of pages.';
    }
    refresh();
  }

  fileInput.onchange = () => setFile(fileInput.files[0]);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); setFile(e.dataTransfer.files[0]); });

  $('pages').oninput = e => { form.pages = Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 1)); refresh(); };
  document.querySelectorAll('input[name=color]').forEach(r => r.onchange = () => { form.color = r.value; refresh(); });
  document.querySelectorAll('input[name=paper]').forEach(r => r.onchange = () => { form.paper = r.value; refresh(); });
  $('minus').onclick = () => { form.copies = Math.max(1, form.copies - 1); $('copies').textContent = form.copies; refresh(); };
  $('plus').onclick = () => { form.copies = Math.min(50, form.copies + 1); $('copies').textContent = form.copies; refresh(); };
  $('shop').onchange = e => { form.shop = e.target.value; };
  $('pay').onclick = () => { askNotificationPermission(); openGcash(form); };

  refresh();
}

// ---------- Fake GCash payment, then send the order + file to the server ----------
function openGcash(form) {
  const p = priceFor(form);
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="gc-title">
      <div class="gcash">
        <div class="bar"><span id="gc-title">GCash</span><small>DEMO · no real payment</small></div>
        <div class="body" id="gc-body">
          <p class="muted small">Pay to</p>
          <p style="font-weight:700">PrintDali · ${esc(form.shop)}</p>
          <p class="amount">${peso(p.total)}</p>
          <button class="btn btn-pay btn-block" id="gc-pay">Pay ${peso(p.total)}</button>
          <button class="btn btn-ghost btn-block" id="gc-cancel">Cancel</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('gc-cancel').onclick = close;
  document.getElementById('gc-pay').focus();
  document.getElementById('gc-pay').onclick = async () => {
    const body = document.getElementById('gc-body');
    body.innerHTML = `<div class="spinner" aria-hidden="true"></div><p>Processing payment and sending your file…</p>`;
    const info = { fileName: form.file.name, pages: form.pages, copies: form.copies, color: form.color, paper: form.paper, shop: form.shop };
    try {
      const [order] = await Promise.all([
        api('POST', '/api/orders', form.file, {
          'Content-Type': 'application/octet-stream',
          'X-Order-Info': encodeURIComponent(JSON.stringify(info)),
        }),
        delay(1000),
      ]);
      addMyCode(order.code);
      lastStatus[order.code] = order.status;
      if (!getOrder(order.code)) orders.push(order);
      close();
      location.hash = '#order/' + order.code;
      toast(`Paid ${peso(order.total)}. Order #${order.code} sent to the shop!`);
    } catch (err) {
      body.innerHTML = `<p style="font-weight:700">Couldn't send your order</p><p class="small muted">${esc(err.message)}</p><button class="btn btn-ghost btn-block" id="gc-close">Close</button>`;
      document.getElementById('gc-close').onclick = close;
    }
  };
}

// ---------- Student: order status ----------
function renderOrder(code) {
  const o = getOrder(code);
  if (!o) {
    app.innerHTML = `<a class="linkback" href="#student">← Back</a><p class="empty">Order not found.</p>`;
    return;
  }
  const steps = ['waiting', 'printing', 'ready', 'picked'];
  const idx = steps.indexOf(o.status);
  const s = STATUS[o.status];
  app.innerHTML = `
    <a class="linkback" href="#student">← My orders</a>
    <section class="status-hero ${o.status}">
      ${o.status === 'ready' ? `<svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="#1B2433" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>` : ''}
      <h2>${s.title}</h2>
      <p class="bigcode">#${o.code}</p>
      <p>${s.note}</p>
      <p class="small"><strong>${esc(o.shop)}</strong></p>
    </section>
    ${o.status === 'waiting' ? `
    <section class="queue" aria-live="polite">
      <p class="small muted">Your place in line</p>
      <p class="queue-num">#${aheadOf(o) + 1}</p>
      <p style="font-weight:700">${lineText(o)}</p>
      <p class="small muted">This updates live. You'll get an alert when it's ready.</p>
    </section>` : ''}
    <section class="card">
      <ol class="steps">
        ${steps.map((st, i) => `
          <li class="${i < idx ? 'done' : i === idx ? 'current' : ''}">
            <span class="dot" aria-hidden="true">${i < idx ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F5C842" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>' : ''}</span>
            ${STATUS[st].title}${i === idx ? ' (now)' : ''}
          </li>`).join('')}
      </ol>
    </section>
    <section class="card">
      <h3 style="font-size:17px">Order details</h3>
      <div class="summary small">
        <div class="line"><span>File</span><span style="text-align:right;overflow-wrap:anywhere">${esc(o.fileName)}</span></div>
        <div class="line"><span>Print</span><span>${o.pages} pg × ${o.copies} · ${o.color === 'bw' ? 'B&amp;W' : 'Color'} · ${esc(o.paper)}</span></div>
        <div class="line"><span>Ordered</span><span>${fmtTime(o.createdAt)}</span></div>
        <div class="line total"><span>Paid (GCash)</span><span>${peso(o.total)}</span></div>
      </div>
    </section>`;
}

// ---------- Print shop dashboard ----------
let shopFilter = 'All shops';
function renderShop() {
  const list = shopFilter === 'All shops' ? orders : orders.filter(o => o.shop === shopFilter);
  const today = new Date().toDateString();
  const todays = list.filter(o => new Date(o.createdAt).toDateString() === today);
  const col = st => list.filter(o => o.status === st).sort((a, b) => a.createdAt - b.createdAt);

  const ticket = o => `
    <article class="ticket">
      <div class="top"><span class="code">#${o.code}</span><span class="small muted">${fmtTime(o.createdAt)}</span></div>
      <p class="file">${esc(o.fileName)}</p>
      <p class="small muted">${o.pages} pg × ${o.copies} · ${o.color === 'bw' ? 'B&amp;W' : 'Color'} · ${esc(o.paper)}</p>
      <p class="small">Paid <strong>${peso(o.total)}</strong>${shopFilter === 'All shops' ? ` · ${esc(o.shop)}` : ''}</p>
      <div class="actions">
        <a class="btn btn-ghost btn-small" href="${o.fileUrl}" target="_blank" rel="noopener">Open file</a>
        ${o.status === 'waiting' ? `<button class="btn btn-dark btn-small" data-act="printing" data-code="${o.code}">Start printing</button>` : ''}
        ${o.status === 'printing' ? `<button class="btn btn-primary btn-small" data-act="ready" data-code="${o.code}">Mark as ready</button>` : ''}
        ${o.status === 'ready' ? `<button class="btn btn-dark btn-small" data-act="picked" data-code="${o.code}">Picked up</button>` : ''}
      </div>
    </article>`;

  const column = (st, title) => {
    const items = col(st);
    return `<section class="column" aria-label="${title}">
      <h2>${title} <span class="count">${items.length}</span></h2>
      ${items.length ? items.map(ticket).join('') : `<p class="empty">Nothing here.</p>`}
    </section>`;
  };

  app.innerHTML = `
    <div class="shop-head">
      <div>
        <p class="eyebrow">Print shop</p>
        <h1 style="font-size:28px">Order queue</h1>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label for="shopfilter" class="small" style="font-weight:600">Showing</label>
        <select class="input" id="shopfilter" style="width:auto">
          ${['All shops', ...CONFIG.shops].map(s => `<option ${s === shopFilter ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-small" id="reset">Reset demo</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><p class="small muted">Orders today</p><p class="num">${todays.length}</p></div>
      <div class="stat"><p class="small muted">Waiting</p><p class="num">${col('waiting').length}</p></div>
      <div class="stat"><p class="small muted">Ready for pickup</p><p class="num">${col('ready').length}</p></div>
      <div class="stat"><p class="small muted">Printing sales today</p><p class="num">${peso(todays.reduce((s, o) => s + o.printing, 0))}</p></div>
    </div>
    <div class="columns">
      ${column('waiting', 'Waiting')}
      ${column('printing', 'Printing')}
      ${column('ready', 'Ready for pickup')}
    </div>
    ${col('picked').length ? `<p class="small muted">${col('picked').length} order(s) already picked up.</p>` : ''}
    <div id="confirm"></div>`;

  document.getElementById('shopfilter').onchange = e => { shopFilter = e.target.value; renderShop(); };
  app.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const updated = await api('PATCH', `/api/orders/${b.dataset.code}`, JSON.stringify({ status: b.dataset.act }), { 'Content-Type': 'application/json' });
        Object.assign(getOrder(updated.code) || {}, updated);
        if (updated.status === 'ready') toast(`#${updated.code} marked ready. The student gets an alert.`);
        renderShop();
      } catch (err) { toast(err.message); b.disabled = false; }
    };
  });
  document.getElementById('reset').onclick = () => {
    document.getElementById('confirm').innerHTML = `
      <div class="card" role="alertdialog" aria-labelledby="rc">
        <p id="rc"><strong>Delete all orders and uploaded files?</strong> This clears the demo for every device.</p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-small" id="rc-yes">Delete all</button>
          <button class="btn btn-ghost btn-small" id="rc-no">Cancel</button>
        </div>
      </div>`;
    document.getElementById('rc-no').onclick = () => { document.getElementById('confirm').innerHTML = ''; };
    document.getElementById('rc-yes').onclick = async () => {
      try {
        await api('DELETE', '/api/orders');
        document.getElementById('confirm').innerHTML = '';
        orders = [];
        renderShop();
        toast('All orders cleared.');
      } catch (err) { toast(err.message); }
    };
  };
}

// ---------- Start ----------
async function start() {
  try {
    CONFIG = await api('GET', '/api/config');
    const snap = await api('GET', '/api/orders');
    orders = snap.orders;
    orders.forEach(o => { lastStatus[o.code] = o.status; });
  } catch {
    app.innerHTML = `
      <section class="card">
        <h2 style="font-size:20px">Can't reach the PrintDali server</h2>
        <p>Make sure the server is running on the laptop (double-click <strong>START-PrintDali.bat</strong>) and that you opened the address it shows.</p>
        <button class="btn btn-dark" onclick="location.reload()">Try again</button>
      </section>`;
    return;
  }
  route();
  connectLive();
}
start();

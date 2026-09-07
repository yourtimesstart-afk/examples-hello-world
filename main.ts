// ============================================================
// Bharat Billing — WORLDWIDE SYNC RELAY (Deno Deploy, free)
// Publisher: Cropzeq Technologies
// Where to run: https://dash.deno.com → New Playground → paste this whole file → Save & Deploy
// Storage: Deno KV (permanent, free) — license records never lost
// ============================================================
const ADMIN_USER = 'CROPZEQ';
const ADMIN_PASS = '4583';

async function adminTok() {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ADMIN_USER + '|' + ADMIN_PASS + '|cropzeq-admin-sync'));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const kv = await Deno.openKv();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-admin-token',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
function j(data, code = 200) { return new Response(JSON.stringify(data), { status: code, headers: CORS }); }
const clean = (v, m) => String(v ?? '').trim().slice(0, m || 120);
const num = v => Math.max(0, Math.min(1e9, Math.floor(+v) || 0));

Deno.serve(async (req) => {
  const u = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method === 'GET' && u === '/health')
    return j({ ok: true, service: 'bharat-billing-relay', storage: 'deno-kv', time: new Date().toISOString() });

  /* ---- installation reports in (from anywhere in the world) ---- */
  if (req.method === 'POST' && u === '/api/sync-report') {
    const b = await req.json().catch(() => null);
    if (!b) return j({ ok: false, error: 'bad json' }, 400);
    const id = clean(b.installId, 40).replace(/[^A-Za-z0-9-]/g, '');
    if (!id) return j({ ok: false, error: 'missing installId' }, 400);
    const prev = (await kv.get(['inst', id])).value || {};
    const rec = {
      installId: id,
      appVersion: clean(b.appVersion, 10),
      business: {
        name: clean(b.business && b.business.name), gstin: clean(b.business && b.business.gstin, 15),
        phone: clean(b.business && b.business.phone), email: clean(b.business && b.business.email),
        address: clean(b.business && b.business.address, 200),
      },
      license: { state: clean(b.license && b.license.state, 20), key: clean(b.license && b.license.key, 40), trialStart: clean(b.license && b.license.trialStart, 30) },
      counts: {
        invoices: num(b.counts && b.counts.invoices), customers: num(b.counts && b.counts.customers),
        products: num(b.counts && b.counts.products), totalBilled: num(b.counts && b.counts.totalBilled),
        lastInvoiceNo: clean(b.counts && b.counts.lastInvoiceNo, 15),
      },
      active: prev.active === false ? false : prev.active === true ? true : undefined,
      notif: prev.notif || null,
      firstSeen: prev.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    await kv.set(['inst', id], rec);
    const out = { ok: true };
    if (rec.active !== undefined) out.active = rec.active;
    if (rec.notif && rec.notif.id) out.notif = rec.notif;
    return j(out);
  }

  
  if (req.method === 'GET' && u === '/api/check') {
    /* light status poll (1 KV READ = free) */
    const id = clean(new URL(req.url).searchParams.get('id'), 40).replace(/[^A-Za-z0-9-]/g, '');
    if (!id) return j({ ok: false, error: 'missing id' }, 400);
    const v = (await kv.get(['inst', id])).value;
    if (!v) return j({ ok: false, error: 'unknown install' });
    const out = { ok: true };
    if (v.active !== undefined) out.active = v.active;
    if (v.notif && v.notif.id) out.notif = v.notif;
    return j(out);
  }

  /* ---- admin: sign in ---- */
  if (req.method === 'POST' && u === '/api/admin/login') {
    const b = await req.json().catch(() => null);
    if (b && b.user === ADMIN_USER && b.pass === ADMIN_PASS) return j({ ok: true, token: await adminTok() });
    return j({ ok: false, error: 'wrong username or password' }, 401);
  }

  /* ---- admin: everything below needs the token ---- */
  if ((req.headers.get('x-admin-token') || '') !== await adminTok()) return j({ ok: false, error: 'admin token required' }, 401);

  if (req.method === 'GET' && u === '/api/admin/stats') {
    const list = [];
    for await (const e of kv.list({ prefix: ['inst'] })) list.push(e.value);
    const sm = { total: list.length, pro: 0, trial: 0, deactivated: 0, totalInvoices: 0, totalBilled: 0 };
    list.forEach(r => {
      if (r.license && r.license.state === 'pro') sm.pro++; else sm.trial++;
      if (r.active === false) sm.deactivated++;
      sm.totalInvoices += (r.counts && r.counts.invoices) || 0;
      sm.totalBilled += (r.counts && r.counts.totalBilled) || 0;
    });
    return j({ ok: true, installs: list, summary: sm });
  }

  if (req.method === 'POST' && u === '/api/admin/set-active') {
    const b = await req.json().catch(() => null);
    const id = clean(b && b.installId, 40);
    if (!id) return j({ ok: false, error: 'missing installId' }, 400);
    const e = await kv.get(['inst', id]);
    if (!e.value) return j({ ok: false, error: 'installation not found (appears here after the user is online once)' }, 404);
    e.value.active = !!(b && b.active);
    await kv.set(['inst', id], e.value);
    return j({ ok: true, active: e.value.active });
  }

  if (req.method === 'POST' && u === '/api/admin/notify') {
    const b = await req.json().catch(() => null);
    const title = clean(b && b.title, 80), message = clean(b && b.message, 500);
    if (!title || !message) return j({ ok: false, error: 'title and message required' }, 400);
    const notif = { id: Date.now(), title: title, message: message, at: new Date().toISOString() };
    const ids = Array.isArray(b && b.installIds) ? b.installIds.map(x => clean(x, 40)) : [];
    const all = !ids.length || !!(b && b.all);
    let n = 0;
    for await (const e of kv.list({ prefix: ['inst'] })) {
      if (all || ids.includes(e.value.installId)) { e.value.notif = notif; await kv.set(e.key, e.value); n++; }
    }
    return j({ ok: true, n: n });
  }

  return j({ ok: false, error: 'not found' }, 404);
});

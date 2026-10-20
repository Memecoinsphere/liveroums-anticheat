const test = require('node:test'), assert = require('node:assert');
const { createApp } = require('../src/server'), { open } = require('../src/db');
const TOKEN = 'jeton-de-test-tres-long-0123456789';
let srv, base;
test.before(async () => { const { app } = createApp({ db: open(':memory:'), env: { NODE_ENV: 'test', ADMIN_TOKEN: TOKEN } }); await new Promise(r => { srv = app.listen(0, r); }); base = `http://127.0.0.1:${srv.address().port}`; });
test.after(() => srv.close());
const jar = () => { let c = ''; return async (path, o = {}) => { const r = await fetch(base + path, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: c } }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) c = sc.map(s => s.split(';')[0]).join('; '); return r; }; };
const csrf = html => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('/healthz public', async () => { const r = await fetch(base + '/healthz'); assert.equal(r.status, 200); });
test('sans session → redirection vers /connexion', async () => {
  for (const p of ['/', '/alertes', '/import', '/signaux', '/joueurs/x']) { const r = await fetch(base + p, { redirect: 'manual' }); assert.ok([302, 303].includes(r.status), p); assert.match(r.headers.get('location'), /\/connexion/); }
});
test('en-têtes de sécurité (helmet, CSP)', async () => {
  const r = await fetch(base + '/connexion'); assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(!r.headers.get('x-powered-by'));
});
test('POST sans CSRF → 403', async () => { const f = jar(); await f('/connexion'); const r = await f('/connexion', form({ token: TOKEN })); assert.equal(r.status, 403); });
test('mauvais jeton refusé', async () => {
  const f = jar(); const t = csrf(await (await f('/connexion')).text()); assert.ok(t);
  const r = await f('/connexion', form({ token: 'mauvais', _csrf: t })); assert.match(r.headers.get('location') || '', /\/connexion/); assert.match(await (await f('/connexion')).text(), /Jeton invalide/);
  assert.ok([302, 303].includes((await f('/')).status));
});
test('bon jeton → accès au tableau de bord, puis déconnexion', async () => {
  const f = jar(); const t = csrf(await (await f('/connexion')).text());
  const r = await f('/connexion', form({ token: TOKEN, _csrf: t })); assert.ok([302, 303].includes(r.status));
  const d = await f('/'); assert.equal(d.status, 200); const html = await d.text(); assert.match(html, /Tableau de bord/);
  assert.equal((await f('/analyser', form({}))).status, 403); // CSRF exigé aussi une fois connecté
  const t2 = csrf(html); const o = await f('/deconnexion', form({ _csrf: t2 })); assert.ok([302, 303].includes(o.status));
  assert.ok([302, 303].includes((await f('/')).status));
});
test('intégration iframe : frame-ancestors limité au site, pas de X-Frame-Options DENY', async () => {
  const r = await fetch(base + '/connexion'); const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/liveroums-arena\.onrender\.com/); assert.equal(r.headers.get('x-frame-options'), null);
});
test('production : cookie de session SameSite=None; Secure, origines d’iframe configurables', async () => {
  const { app } = createApp({ db: open(':memory:'), env: { NODE_ENV: 'production', ADMIN_TOKEN: TOKEN, SESSION_SECRET: 'x'.repeat(40), ALLOWED_FRAME_ANCESTORS: "'self' https://exemple.gg javascript:alert(1)" } });
  app.set('trust proxy', 1);
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/connexion`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/exemple\.gg$/);
    const ck = (r.headers.getSetCookie() || []).join(';'); assert.match(ck, /SameSite=None/i); assert.match(ck, /Secure/i);
  } finally { s.close(); }
});

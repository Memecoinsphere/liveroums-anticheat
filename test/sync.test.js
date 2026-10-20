// Synchronisation avec l'export admin du site : serveur du site simulé (export + webhook Discord)
const test = require('node:test'), assert = require('node:assert'), http = require('node:http');
const S = require('../src/synthetic'), { open } = require('../src/db'), { createSync } = require('../src/sync'), { createApp } = require('../src/server');
const TOKEN = 'export-token-de-test-123';
const ds = S.build();
const toExport = (players, matches) => ({ format: 'liveroums-anticheat-export/v1', generated_at: new Date().toISOString(),
  players: players.map(p => ({ ...p, linked: ds.linked.filter(l => l.pseudo === p.pseudo) })),
  matches: matches.map(m => ({ ...m, started_at: m.first_seen.replace(' ', 'T') + 'Z', ended_at: m.ended_seen.replace(' ', 'T') + 'Z' })), points: [{ pseudo: 'NewKid', amount: 100 }] });
// Le site simulé : la moitié des parties au départ, le reste n'apparaît qu'en incrémental
const half = Math.floor(ds.matches.length / 2);
const mock = { mode: 'ok', calls: [], hooks: [], phase: 1 };
let srv, base;
test.before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/webhook') { let b = ''; req.on('data', c => b += c); req.on('end', () => { mock.hooks.push(JSON.parse(b)); res.writeHead(204).end(); }); return; }
    if (u.pathname !== '/api/admin/anticheat-export') return res.writeHead(404).end();
    mock.calls.push({ since: u.searchParams.get('since'), auth: req.headers.authorization });
    if (mock.mode === '404') return res.writeHead(404, { 'content-type': 'application/json' }).end('{"erreur":"Export désactivé."}');
    if (mock.mode === '429') return res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' }).end('{}');
    if (mock.mode === 'garbage') return res.writeHead(200, { 'content-type': 'application/json' }).end('<html>');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"erreur":"Jeton invalide."}');
    const since = u.searchParams.get('since');
    const matches = mock.phase === 1 ? ds.matches.slice(0, half) : since ? ds.matches.slice(half) : ds.matches;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(toExport(ds.players, matches)));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
  process.env.DISCORD_WEBHOOK_URL = base + '/webhook';
});
test.after(() => { delete process.env.DISCORD_WEBHOOK_URL; srv.close(); });
const quiet = { warn() {}, log() {} };
const count = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

test('synchro complète puis incrémentale (since = dernière synchro), analyse + alertes Discord sans doublon', async () => {
  const db = open(':memory:'); mock.mode = 'ok'; mock.phase = 1; mock.calls = []; mock.hooks = [];
  const sy = createSync(db, { base, token: TOKEN, intervalS: 300, log: quiet });
  const r1 = await sy.once(); assert.ok(r1.ok, r1.error); assert.equal(r1.mode, 'complète');
  assert.equal(mock.calls[0].since, null); assert.equal(mock.calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(count(db, "matches"), half); assert.equal(r1.counts.joueurs, ds.players.length);
  mock.phase = 2;
  const r2 = await sy.once(); assert.ok(r2.ok); assert.equal(r2.mode, 'incrémentale');
  const since = mock.calls[1].since; assert.ok(since && Date.parse(since) <= Date.now() && Date.now() - Date.parse(since) < 5 * 60e3, 'since = horodatage de la dernière synchro (moins le chevauchement)');
  assert.equal(count(db, 'matches'), ds.matches.length, 'toutes les parties, sans doublon');
  const suspects = db.prepare('SELECT DISTINCT pseudo FROM alerts').all().map(r => r.pseudo);
  for (const p of ['NewKid', 'ShadowFox', 'TradeA']) assert.ok(suspects.includes(p), p);
  const alerts = count(db, 'alerts'), hooks = mock.hooks.length; assert.ok(hooks >= 3 && hooks === alerts, `webhook ${hooks} / alertes ${alerts}`);
  // Nouvelle synchro identique + synchro forcée complète : aucune alerte ni notification en double
  await sy.once(); await sy.once({ full: true });
  assert.equal(count(db, 'alerts'), alerts); assert.equal(mock.hooks.length, hooks);
  assert.equal(count(db, 'matches'), ds.matches.length); assert.equal(sy.status().fails, 0); assert.ok(sy.healthy());
});
test('démarrage : la première synchro est complète même avec un curseur (base éphémère)', async () => {
  const db = open(':memory:'); mock.mode = 'ok'; mock.calls = [];
  db.kvSet('sync_status', JSON.stringify({ cursor: '2026-01-01T00:00:00Z' }));
  const sy = createSync(db, { base, token: TOKEN, log: quiet }); await sy.once();
  assert.equal(mock.calls[0].since, null);
});
test('401 : jeton refusé → erreur explicite, backoff long, pas de crash', async () => {
  const db = open(':memory:'); mock.mode = 'ok';
  const sy = createSync(db, { base, token: 'mauvais', intervalS: 300, log: quiet });
  const r = await sy.once(); assert.equal(r.ok, false); assert.equal(r.kind, 'auth'); assert.match(r.error, /401/);
  assert.ok(r.delay >= 15 * 60e3); assert.ok(!sy.healthy()); assert.equal(count(db, 'players'), 0);
});
test('404 : export désactivé sur le site', async () => {
  mock.mode = '404'; const sy = createSync(open(':memory:'), { base, token: TOKEN, log: quiet });
  const r = await sy.once(); assert.equal(r.kind, 'auth'); assert.match(r.error, /désactivé/);
});
test('429 : respecte Retry-After puis reprend normalement', async () => {
  const db = open(':memory:'); mock.mode = '429';
  const sy = createSync(db, { base, token: TOKEN, intervalS: 60, log: quiet });
  const r = await sy.once(); assert.equal(r.kind, 'rate'); assert.equal(r.delay, 120000); assert.ok(sy.inBackoff());
  const r2 = await sy.once(); assert.ok(r2.delay >= 120000 && sy.status().fails === 2);
  mock.mode = 'ok'; mock.phase = 1; const r3 = await sy.once(); assert.ok(r3.ok); assert.equal(sy.status().fails, 0); assert.equal(sy.status().last_error, null); assert.ok(!sy.inBackoff());
});
test('réseau coupé / réponse invalide : backoff exponentiel plafonné, jamais d\'exception', async () => {
  const db = open(':memory:'); const delays = [];
  const sy = createSync(db, { base: 'http://127.0.0.1:1', token: TOKEN, intervalS: 60, log: quiet });
  for (let i = 0; i < 8; i++) delays.push((await sy.once()).delay);
  assert.deepEqual(delays.slice(0, 3), [120000, 240000, 480000]); assert.ok(delays.every(d => d <= 3600e3)); assert.equal(delays.at(-1), 3600e3);
  mock.mode = 'garbage'; const g = await createSync(db, { base, token: TOKEN, log: quiet }).once(); assert.equal(g.ok, false); assert.match(g.error, /JSON/);
  const broken = await createSync(db, { base, token: TOKEN, log: quiet, fetchImpl: () => { throw new TypeError('boom'); } }).once(); assert.equal(broken.ok, false);
});
test('sans SITE_EXPORT_TOKEN : synchro désactivée, aucune requête', async () => {
  mock.calls = []; const sy = createSync(open(':memory:'), { base, token: '', log: quiet });
  assert.equal((await sy.once()).ok, false); sy.start(0); assert.equal(mock.calls.length, 0); assert.equal(sy.status().enabled, false);
});
test('tableau de bord : statut de synchro + bouton « Synchroniser maintenant » protégé par CSRF', async () => {
  mock.mode = 'ok'; mock.phase = 1;
  const ADMIN = 'jeton-admin-de-test-0123456789';
  const { app } = createApp({ db: open(':memory:'), env: { NODE_ENV: 'test', ADMIN_TOKEN: ADMIN, SITE_URL: base, SITE_EXPORT_TOKEN: TOKEN }, syncOpts: { log: quiet } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }), B = `http://127.0.0.1:${s.address().port}`;
  let c = ''; const f = async (p, o = {}) => { const r = await fetch(B + p, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: c } }); const sc = r.headers.getSetCookie(); if (sc.length) c = sc.map(x => x.split(';')[0]).join('; '); return r; };
  const csrf = h => h.match(/name="_csrf" value="([^"]+)"/)[1], form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  try {
    await f('/connexion', form({ token: ADMIN, _csrf: csrf(await (await f('/connexion')).text()) }));
    let h = await (await f('/')).text(); assert.match(h, /Synchroniser maintenant/); assert.match(h, /Export du site/);
    assert.equal((await f('/synchroniser', form({}))).status, 403, 'CSRF exigé');
    const r = await f('/synchroniser', form({ _csrf: csrf(h) })); assert.equal(r.status, 303);
    h = await (await f('/')).text(); assert.match(h, /Synchro complète/); assert.match(h, /Dernière synchro réussie : <b>\d\d\/\d\d\/\d{4}/); assert.match(h, /en veille \(secours\)/);
  } finally { s.close(); }
});

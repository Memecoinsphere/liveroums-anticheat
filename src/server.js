// Serveur du tableau de bord anti-triche (Express) : connexion par ADMIN_TOKEN, session sécurisée, CSRF, helmet, limites de débit
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { open } = require('./db');
const { collector } = require('./collector');
const engine = require('./engine');
const { importData } = require('./importer');
const V = require('./views');
const { esc } = V;

function createApp({ db = open(), env = process.env } = {}) {
  const PROD = env.NODE_ENV === 'production';
  const TOKEN = env.ADMIN_TOKEN || '';
  if (TOKEN.length < 16) { if (PROD) { console.error('FATAL : ADMIN_TOKEN absent ou trop court (16 caractères minimum).'); process.exit(1); } }
  const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  if (PROD && (env.SESSION_SECRET || '').length < 32) { console.error('FATAL : SESSION_SECRET absent ou trop court (32 caractères minimum).'); process.exit(1); }

  class Store extends session.Store {
    get(sid, cb) { const r = db.prepare('SELECT sess,expires FROM sessions WHERE sid=?').get(sid); cb(null, r && r.expires > Date.now() ? JSON.parse(r.sess) : null); }
    set(sid, s, cb = () => {}) { db.prepare('INSERT OR REPLACE INTO sessions(sid,sess,expires) VALUES(?,?,?)').run(sid, JSON.stringify(s), new Date(s.cookie.expires || Date.now() + 864e5).getTime()); cb(null); }
    destroy(sid, cb = () => {}) { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); }
    touch(sid, s, cb = () => {}) { this.set(sid, s, cb); }
  }
  const app = express();
  app.set('trust proxy', 1); app.disable('x-powered-by');
  app.use((req, res, next) => { res.locals.nonce = crypto.randomBytes(16).toString('base64'); next(); });
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'self'"], 'script-src': ["'self'", (q, r) => `'nonce-${r.locals.nonce}'`], 'script-src-attr': ["'none'"],
    'style-src': ["'self'", 'https://fonts.googleapis.com'], 'font-src': ["'self'", 'https://fonts.gstatic.com'], 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"],
    'object-src': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"] } },
    strictTransportSecurity: PROD ? { maxAge: 31536000, includeSubDomains: true } : false, referrerPolicy: { policy: 'no-referrer' }, frameguard: { action: 'deny' } }));
  app.use(express.static(require('path').join(__dirname, '..', 'public')));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(express.urlencoded({ extended: false, limit: '6mb', parameterLimit: 50 }));
  app.use(session({ name: 'ac.sid', secret: SECRET, store: new Store(), resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 8 * 36e5 } }));
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, handler: (req, res) => res.status(429).send('Trop de requêtes. Réessaie plus tard.') });
  app.use(limiter(6e4, 300));
  // CSRF : jeton par session, ajouté à chaque formulaire POST rendu
  const csrfToken = req => req.session.csrf ||= crypto.randomBytes(32).toString('hex');
  app.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = b => send(typeof b === 'string' && b.startsWith('<!doctype html>') ? b.replace(/<script(?=[\s>])/g, `<script nonce="${res.locals.nonce}"`).replace(/(<form\b[^>]*method="post"[^>]*>)/gi, `$1<input type="hidden" name="_csrf" value="${csrfToken(req)}">`) : b);
    res.page = (title, body, o = {}) => { const flash = req.session.flash; delete req.session.flash; res.send(V.layout(title, body, { flash, ...o })); };
    req.flash = (type, msg) => { req.session.flash = { type, msg }; };
    if (req.method !== 'POST') return next();
    const t = req.body?._csrf, s = req.session.csrf;
    if (!s || typeof t !== 'string' || t.length !== s.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s))) return res.status(403).send('Jeton CSRF invalide. Recharge la page.');
    next();
  });
  // ---- Connexion ----
  const hash = s => crypto.createHash('sha256').update(String(s)).digest();
  app.get('/connexion', (req, res) => res.page('Connexion', `<section class="login panel"><h1>🛡️ Accès administrateur</h1>
    <form method="post" action="/connexion" class="form"><label>Jeton d'administration<input type="password" name="token" required maxlength="200" autocomplete="current-password"></label>
    <button class="btn lg">Se connecter</button></form>${TOKEN.length < 16 ? '<p class="flash err">ADMIN_TOKEN non configuré : connexion impossible.</p>' : ''}</section>`, { auth: false }));
  app.post('/connexion', limiter(15 * 6e4, 10), (req, res) => {
    const ok = TOKEN.length >= 16 && crypto.timingSafeEqual(hash(req.body.token || ''), hash(TOKEN));
    if (!ok) { req.flash('err', 'Jeton invalide.'); return res.redirect(303, '/connexion'); }
    req.session.regenerate(e => { if (e) return res.status(500).send('Erreur'); req.session.admin = true; res.redirect(303, '/'); });
  });
  app.post('/deconnexion', (req, res) => req.session.destroy(() => { res.clearCookie('ac.sid'); res.redirect(303, '/connexion'); }));
  app.use((req, res, next) => req.session.admin ? next() : res.redirect(303, '/connexion'));

  // ---- Tableau de bord ----
  const lastDecision = p => db.prepare('SELECT decision FROM reviews WHERE pseudo=? ORDER BY id DESC LIMIT 1').get(p)?.decision;
  app.get('/', (req, res) => {
    const th = engine.THRESHOLD(), rows = db.prepare('SELECT s.*, p.sr, p.wins, p.losses FROM scores s LEFT JOIN players p ON p.pseudo=s.pseudo ORDER BY s.score DESC, s.pseudo LIMIT 200').all();
    const n = q => db.prepare(q).get().n;
    const st = { joueurs: n('SELECT COUNT(*) n FROM players'), parties: n("SELECT COUNT(*) n FROM matches WHERE status='termine'"), alertes: n('SELECT COUNT(*) n FROM alerts WHERE seen=0'), suspects: n(`SELECT COUNT(*) n FROM scores WHERE score>=${th}`) };
    res.page('Tableau de bord', `<section><div class="head"><h1>Tableau de bord</h1><div class="acts"><form method="post" action="/collecter"><button class="btn ghost sm">📡 Collecter maintenant</button></form><form method="post" action="/analyser"><button class="btn sm">🧠 Recalculer les scores</button></form></div></div>
    <div class="stats"><div><b>${st.joueurs}</b><span>joueurs suivis</span></div><div><b>${st.parties}</b><span>parties analysées</span></div><div><b>${st.suspects}</b><span>score ≥ ${th}</span></div><div class="${st.alertes ? 'hot' : ''}"><b>${st.alertes}</b><span>alertes non lues</span></div></div>
    <p class="muted sm">Dernière analyse : ${V.fmt(db.kvGet('last_scan'))} · dernière collecte : ${V.fmt(db.kvGet('last_collect'))} · source : ${esc(env.SITE_URL || 'https://liveroums-arena.onrender.com')}</p>
    <div class="table-wrap"><table><tr><th>Score</th><th>Joueur</th><th>SR</th><th>V / D</th><th>Signaux principaux</th><th>Décision admin</th></tr>
    ${rows.map(r => { const rs = JSON.parse(r.reasons); return `<tr class="${r.score >= th ? 'sus' : ''}"><td>${V.scoreBadge(r.score)}</td><td><a href="/joueurs/${encodeURIComponent(r.pseudo)}"><b>${esc(r.pseudo)}</b></a></td><td>${r.sr ?? '—'}</td><td>${r.wins ?? 0} / ${r.losses ?? 0}</td>
      <td class="sm">${rs.slice(0, 2).map(x => `<div><span class="det">${esc(V.DET[x.detecteur] || x.detecteur)}</span> ${esc(x.texte)}</div>`).join('') || '<span class="muted">—</span>'}</td><td>${V.decBadge(lastDecision(r.pseudo))}</td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">Aucune donnée. Lance une collecte ou importe un fichier.</td></tr>'}</table></div></section>`);
  });
  app.get('/joueurs/:pseudo', (req, res) => {
    const p = db.prepare('SELECT * FROM players WHERE pseudo=?').get(req.params.pseudo); if (!p) return res.status(404).page('Introuvable', '<h1>Joueur inconnu</h1>');
    const s = db.prepare('SELECT * FROM scores WHERE pseudo=?').get(p.pseudo), rs = s ? JSON.parse(s.reasons) : [];
    const linked = db.prepare('SELECT * FROM linked WHERE pseudo=?').all(p.pseudo), revs = db.prepare('SELECT * FROM reviews WHERE pseudo=? ORDER BY id DESC').all(p.pseudo);
    const ms = db.prepare(`SELECT m.*, mp.team, mp.sr_before, mp.sr_after FROM match_players mp JOIN matches m ON m.code=mp.code WHERE mp.pseudo=? ORDER BY COALESCE(m.ended_seen,m.first_seen) DESC LIMIT 50`).all(p.pseudo);
    const opp = code => db.prepare('SELECT pseudo, team FROM match_players WHERE code=?').all(code);
    res.page(p.pseudo, `<section><div class="head"><h1>${esc(p.pseudo)} ${s ? V.scoreBadge(s.score) : ''}</h1>${V.decBadge(revs[0]?.decision)}</div>
    <div class="cols"><div><h2>Pourquoi ce score ?</h2>${s?.summary ? `<p class="summary">🤖 ${esc(s.summary)}</p>` : ''}${V.reasonsHtml(rs)}
    <h2>Parties observées (${ms.length})</h2><div class="table-wrap"><table><tr><th>Code</th><th>Type</th><th>Équipe</th><th>Résultat</th><th>SR</th><th>Hôte</th><th>Adversaires</th></tr>
    ${ms.map(m => `<tr><td class="code">${esc(m.code)}</td><td>${esc({ classe: 'Classé', rapide: 'Rapide', privee: 'Privée' }[m.kind] || '?')}</td><td>${m.team ?? '—'}</td><td>${m.winner_team ? (m.winner_team === m.team ? '<span class="up">Victoire</span>' : '<span class="down">Défaite</span>') : '—'}</td>
      <td>${m.sr_before ?? '—'}${m.sr_after != null ? ` → ${m.sr_after}` : ''}</td><td>${esc(m.host || '—')}</td><td class="sm">${opp(m.code).filter(o => o.team !== m.team).map(o => `<a href="/joueurs/${encodeURIComponent(o.pseudo)}">${esc(o.pseudo)}</a>`).join(', ')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aucune.</td></tr>'}</table></div></div>
    <aside class="panel"><h3>Fiche</h3><p>SR : <b>${p.sr ?? '—'}</b> · ${p.wins ?? 0} V / ${p.losses ?? 0} D<br>Plateforme : ${esc(p.platform || '—')}<br>Membre depuis : ${esc(p.member_since || '—')}<br>Vu pour la première fois : ${V.fmt(p.first_seen)}</p>
    <h3>Comptes liés</h3>${linked.length ? `<ul>${linked.map(l => `<li><b>${esc(l.provider)}</b> ${esc(l.account_id)} ${l.verified ? '✔' : ''}</li>`).join('')}</ul>` : '<p class="muted">Aucun.</p>'}
    <h3>Décision de l'admin</h3><p class="muted sm">Stockée uniquement dans l'agent. La sanction éventuelle s'applique manuellement sur le site.</p>
    <form method="post" action="/joueurs/${encodeURIComponent(p.pseudo)}/decision" class="form"><select name="decision">${Object.entries(V.DEC).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <textarea name="note" maxlength="1000" rows="3" placeholder="Note (optionnelle)"></textarea><button class="btn sm">Enregistrer</button></form>
    ${revs.map(r => `<div class="rev">${V.decBadge(r.decision)} <small class="muted">${V.fmt(r.created_at)}</small>${r.note ? `<p>${esc(r.note)}</p>` : ''}</div>`).join('')}</aside></div></section>`);
  });
  app.post('/joueurs/:pseudo/decision', (req, res) => {
    const p = db.prepare('SELECT pseudo FROM players WHERE pseudo=?').get(req.params.pseudo);
    if (!p || !V.DEC[req.body.decision]) { req.flash('err', 'Décision invalide.'); return res.redirect(303, '/'); }
    db.prepare('INSERT INTO reviews(pseudo,decision,note) VALUES(?,?,?)').run(p.pseudo, req.body.decision, String(req.body.note || '').slice(0, 1000) || null);
    db.prepare('UPDATE alerts SET seen=1 WHERE pseudo=?').run(p.pseudo);
    req.flash('ok', `Décision enregistrée : ${V.DEC[req.body.decision][0]}.`); res.redirect(303, '/joueurs/' + encodeURIComponent(p.pseudo));
  });
  app.get('/alertes', (req, res) => {
    const rows = db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 200').all();
    res.page('Alertes', `<section><div class="head"><h1>🚨 Alertes</h1><form method="post" action="/alertes/lues"><button class="btn ghost sm">Tout marquer comme lu</button></form></div>
    <p class="muted">Seuil d'alerte : ${engine.THRESHOLD()}/100 · notifications : Discord ${env.DISCORD_WEBHOOK_URL ? 'activé' : 'désactivé'}, email ${env.SMTP_URL && env.ALERT_EMAIL_TO ? 'activé' : 'désactivé'}, résumé IA ${env.LLM_API_KEY ? 'activé' : 'désactivé'}.</p>
    <div class="alerts">${rows.map(a => `<div class="alert panel ${a.seen ? '' : 'new'}"><div class="head">${V.scoreBadge(a.score)} <a href="/joueurs/${encodeURIComponent(a.pseudo)}"><b>${esc(a.pseudo)}</b></a> <small class="muted">${V.fmt(a.created_at)}${a.notified ? ' · notifié : ' + esc(a.notified) : ''}</small></div>${V.reasonsHtml(JSON.parse(a.reasons).slice(0, 4))}</div>`).join('') || '<p class="muted">Aucune alerte.</p>'}</div></section>`);
  });
  app.post('/alertes/lues', (req, res) => { db.prepare('UPDATE alerts SET seen=1').run(); res.redirect(303, '/alertes'); });
  app.get('/import', (req, res) => res.page('Import', `<section class="form-wrap"><h1>📥 Import manuel</h1><p class="muted">Secours si la collecte publique ne suffit pas : JSON complet ou CSV (joueurs, comptes liés ou parties). Voir le README pour les formats.</p>
    <form method="post" action="/import" class="form"><label>Fichier (.json / .csv)<input type="file" id="file" accept=".json,.csv,text/csv,application/json"></label>
    <label>Contenu<textarea name="data" id="data" rows="14" maxlength="6000000" required placeholder='{"players":[{"pseudo":"Viper","sr":1200,"wins":10,"losses":4,"member_since":"2026-10-01","linked":[{"provider":"Activision ID","account_id":"Viper#123"}]}],"matches":[{"code":"AB12CD","kind":"classe","winner_team":1,"host":"Viper","players":[{"pseudo":"Viper","team":1,"sr_before":1180,"sr_after":1200}]}]}'></textarea></label>
    <button class="btn lg">Importer puis analyser</button></form></section>
    <script>document.getElementById('file').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{document.getElementById('data').value=r.result;};r.readAsText(f);});</script>`));
  app.post('/import', limiter(6e4, 10), async (req, res) => {
    try { const n = importData(db, String(req.body.data || '')); const r = await engine.run(db); req.flash('ok', `Import : ${n.joueurs} joueurs, ${n.parties} parties, ${n.comptes} comptes liés, ${n.historique} points d'historique. ${r.alerts} nouvelle(s) alerte(s).`); res.redirect(303, '/'); }
    catch (e) { req.flash('err', 'Import refusé : ' + e.message.slice(0, 200)); res.redirect(303, '/import'); }
  });
  const C = collector(db, { base: env.SITE_URL });
  app.post('/collecter', limiter(6e4, 3), async (req, res) => { const s = await C.cycle(); db.kvSet('last_collect', new Date().toISOString()); const r = await engine.run(db); req.flash('ok', `Collecte : ${s.requests} requêtes cumulées, ${s.errors} erreur(s). ${r.alerts} nouvelle(s) alerte(s).`); res.redirect(303, '/'); });
  app.post('/analyser', async (req, res) => { const r = await engine.run(db); req.flash('ok', `${r.scored} joueurs analysés, ${r.alerts} nouvelle(s) alerte(s).`); res.redirect(303, '/'); });
  app.get('/signaux', (req, res) => res.page('Signaux', require('./signals').html));
  app.use((err, req, res, next) => { console.error(PROD ? err.message : err); res.status(500).send('Erreur interne.'); });
  return { app, db, collector: C };
}

if (require.main === module) {
  const { app, db, collector: C } = createApp();
  const port = process.env.PORT || 3500;
  app.listen(port, () => console.log(`Anti-triche LiveRoums sur http://localhost:${port}`));
  if (process.env.COLLECT_ENABLED !== '0' && process.env.NODE_ENV !== 'test') {
    const every = Math.max(60, +process.env.COLLECT_INTERVAL_S || 180) * 1000;
    const tick = async () => { await C.cycle(); db.kvSet('last_collect', new Date().toISOString()); await engine.run(db).catch(e => console.warn(e.message)); };
    setTimeout(tick, 5000); setInterval(tick, every).unref();
  }
}
module.exports = { createApp };

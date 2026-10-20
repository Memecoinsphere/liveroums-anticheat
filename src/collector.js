// Collecte par interrogation HTTP des pages/API PUBLIQUES du site (sans connexion), avec budget de requêtes.
// Le site limite /api/* à 120 req/min/IP : par défaut l'agent s'impose 40 req/min au total (COLLECT_RPM, plafonné à 100).
const P = require('./parse');

class Bucket { // seau à jetons
  constructor(rpm) { this.rpm = rpm; this.tokens = rpm; this.t = Date.now(); }
  async take() {
    for (;;) {
      const now = Date.now(); this.tokens = Math.min(this.rpm, this.tokens + (now - this.t) * this.rpm / 6e4); this.t = now;
      if (this.tokens >= 1) { this.tokens--; return; }
      await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) * 6e4 / this.rpm)));
    }
  }
}

function collector(db, { base = process.env.SITE_URL || 'https://liveroums-arena.onrender.com', rpm = Math.min(100, +process.env.COLLECT_RPM || 40), fetchImpl = fetch, log = console } = {}) {
  base = base.replace(/\/$/, '');
  const bucket = new Bucket(rpm), stats = { requests: 0, errors: 0, last: null };
  const get = async (path, json) => {
    await bucket.take(); stats.requests++;
    const r = await fetchImpl(base + path, { headers: { 'User-Agent': 'LiveRoums-AntiCheat/1.0 (lecture publique)', Accept: json ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { stats.errors++; throw new Error('429 : limite du site atteinte, pause.'); }
    if (r.status === 404) return null;
    if (!r.ok) { stats.errors++; throw new Error(`HTTP ${r.status} sur ${path}`); }
    return json ? r.json() : r.text();
  };
  const upsert = db.prepare(`INSERT INTO players(pseudo,sr,wins,losses) VALUES(@pseudo,@sr,@wins,@losses)
    ON CONFLICT(pseudo) DO UPDATE SET sr=COALESCE(@sr,sr), wins=COALESCE(@wins,wins), losses=COALESCE(@losses,losses)`);
  const hist = (p) => {
    const last = db.prepare('SELECT sr,wins,losses FROM sr_history WHERE pseudo=? ORDER BY at DESC, rowid DESC LIMIT 1').get(p.pseudo);
    if (p.sr != null && (!last || last.sr !== p.sr || last.wins !== p.wins || last.losses !== p.losses)) db.prepare('INSERT INTO sr_history(pseudo,sr,wins,losses) VALUES(?,?,?,?)').run(p.pseudo, p.sr, p.wins, p.losses);
  };
  async function refreshProfile(pseudo) {
    const html = await get('/joueurs/' + encodeURIComponent(pseudo)); if (!html) return;
    const pr = P.profile(html);
    db.transaction(() => {
      upsert.run({ pseudo, sr: pr.sr, wins: pr.wins, losses: pr.losses }); hist({ pseudo, ...pr });
      db.prepare("UPDATE players SET member_since=COALESCE(?,member_since), platform=COALESCE(?,platform), last_profile=datetime('now') WHERE pseudo=?").run(pr.member_since, pr.platform, pseudo);
      db.prepare('DELETE FROM linked WHERE pseudo=?').run(pseudo);
      pr.linked.forEach(l => db.prepare('INSERT OR REPLACE INTO linked(pseudo,provider,account_id,verified) VALUES(?,?,?,?)').run(pseudo, l.provider, l.account_id, l.verified));
    })();
  }
  async function trackMatch(code) {
    const j = await get('/api/parties/' + encodeURIComponent(code), true); if (!j) return;
    const known = db.prepare('SELECT * FROM matches WHERE code=?').get(code);
    let meta = known && known.kind ? { kind: known.kind, host: known.host } : null;
    if (!meta) { const h = await get('/parties/' + encodeURIComponent(code)); meta = h ? P.matchPage(h) : { kind: j.classe ? 'classe' : null, host: null }; }
    db.transaction(() => {
      db.prepare(`INSERT INTO matches(code,kind,status,winner_team,host) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET status=excluded.status, winner_team=excluded.winner_team,
        kind=COALESCE(matches.kind,excluded.kind), host=COALESCE(matches.host,excluded.host), ended_seen=CASE WHEN excluded.status='termine' AND matches.ended_seen IS NULL THEN datetime('now') ELSE matches.ended_seen END`)
        .run(code, meta.kind || (j.classe ? 'classe' : null), j.statut, j.equipe_gagnante, meta.host);
      for (const p of j.joueurs || []) {
        db.prepare("INSERT OR IGNORE INTO players(pseudo) VALUES(?)").run(p.pseudo);
        db.prepare('INSERT OR REPLACE INTO match_players(code,pseudo,team,sr_before,sr_after) VALUES(?,?,?,?,?)').run(code, p.pseudo, p.equipe, p.sr_avant, p.sr_apres);
      }
    })();
    return j.statut;
  }
  // Un cycle : classement → joueurs (API : partie en cours / file) → parties actives → profils à rafraîchir
  async function cycle() {
    const t0 = Date.now();
    try {
      const html = await get('/classement');
      for (const p of P.leaderboard(html || '')) db.transaction(() => { upsert.run(p); hist(p); })();
      // parties non terminées déjà connues
      for (const m of db.prepare("SELECT code FROM matches WHERE status IS NULL OR status<>'termine' ORDER BY first_seen LIMIT 20").all()) await trackMatch(m.code).catch(e => log.warn(e.message));
      // joueurs : ceux en file classée / partie d'abord, puis les moins récemment vus (budget limité par cycle)
      const budget = Math.max(5, Math.floor(rpm * 0.6));
      const ps = db.prepare("SELECT pseudo FROM players ORDER BY CASE WHEN last_api IS NULL THEN 0 ELSE 1 END, last_api LIMIT ?").all(budget);
      for (const { pseudo } of ps) {
        const j = await get('/api/joueurs/' + encodeURIComponent(pseudo), true).catch(e => { log.warn(e.message); return null; });
        db.prepare("UPDATE players SET last_api=datetime('now') WHERE pseudo=?").run(pseudo);
        if (!j) continue;
        const sr = j.ratings?.['Call of Duty']; if (sr != null) db.prepare('UPDATE players SET sr=? WHERE pseudo=?').run(sr, pseudo);
        if (j.lobby && !db.prepare("SELECT 1 FROM matches WHERE code=? AND status='termine'").get(j.lobby)) await trackMatch(j.lobby).catch(e => log.warn(e.message));
      }
      // profils (comptes liés, date d'inscription) : nouveaux joueurs puis rafraîchissement quotidien
      for (const { pseudo } of db.prepare("SELECT pseudo FROM players WHERE last_profile IS NULL OR last_profile < datetime('now','-1 day') ORDER BY last_profile IS NOT NULL, last_profile LIMIT 5").all())
        await refreshProfile(pseudo).catch(e => log.warn(e.message));
    } catch (e) { stats.errors++; log.warn('Collecte : ' + e.message); }
    stats.last = { at: new Date().toISOString(), ms: Date.now() - t0 };
    return stats;
  }
  return { cycle, refreshProfile, trackMatch, stats, base };
}
module.exports = { collector, Bucket };

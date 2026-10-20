// Import manuel (secours) : JSON complet ou CSV (joueurs / comptes liés / parties, détecté par l'en-tête)
const LIMITS = { players: 20000, matches: 50000 };
const str = (v, n = 60) => v == null || v === '' ? null : String(v).slice(0, n);
const int = v => v == null || v === '' || isNaN(+v) ? null : Math.round(+v);
const date = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' '); };

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',' || c === ';') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some(x => x !== '')) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
// CSV → structure JSON commune
function csvToJson(text) {
  const rows = parseCsv(text); if (!rows.length) throw new Error('CSV vide.');
  const cols = Object.keys(rows[0]);
  if (cols.includes('code')) { // une ligne par joueur de partie
    const M = {}; for (const r of rows) { const m = (M[r.code] ||= { code: r.code, kind: r.kind, winner_team: r.winner_team, host: r.host, ended_at: r.ended_at, players: [] }); if (r.pseudo) m.players.push({ pseudo: r.pseudo, team: r.team, sr_before: r.sr_before, sr_after: r.sr_after }); }
    return { matches: Object.values(M) };
  }
  if (cols.includes('provider')) { const P = {}; rows.forEach(r => (P[r.pseudo] ||= { pseudo: r.pseudo, linked: [] }).linked.push({ provider: r.provider, account_id: r.account_id })); return { players: Object.values(P) }; }
  if (cols.includes('pseudo')) return { players: rows };
  throw new Error('En-tête CSV non reconnu (attendu : pseudo,… / pseudo,provider,account_id / code,pseudo,team,…).');
}
function importData(db, input, source = 'import') {
  const data = typeof input === 'string' ? (input.trim().startsWith('{') || input.trim().startsWith('[') ? JSON.parse(input) : csvToJson(input)) : input;
  const players = Array.isArray(data) ? data : data.players || [], matches = data.matches || [];
  if (players.length > LIMITS.players || matches.length > LIMITS.matches) throw new Error('Import trop volumineux.');
  const n = { joueurs: 0, parties: 0, comptes: 0, historique: 0 };
  db.transaction(() => {
    for (const p of players) {
      const pseudo = str(p.pseudo, 40); if (!pseudo) continue;
      db.prepare(`INSERT INTO players(pseudo,platform,member_since,sr,wins,losses,source) VALUES(?,?,?,?,?,?,?) ON CONFLICT(pseudo) DO UPDATE SET
        platform=COALESCE(excluded.platform,platform), member_since=COALESCE(excluded.member_since,member_since), sr=COALESCE(excluded.sr,sr), wins=COALESCE(excluded.wins,wins), losses=COALESCE(excluded.losses,losses)`)
        .run(pseudo, str(p.platform, 30), p.member_since ? date(p.member_since)?.slice(0, 10) : null, int(p.sr), int(p.wins), int(p.losses), source); n.joueurs++;
      for (const l of p.linked || []) { if (!l.provider || !l.account_id) continue; db.prepare('INSERT OR REPLACE INTO linked(pseudo,provider,account_id,verified) VALUES(?,?,?,?)').run(pseudo, str(l.provider, 40), str(l.account_id, 80), l.verified ? 1 : 0); n.comptes++; }
      for (const h of p.sr_history || []) { if (int(h.sr) == null) continue; db.prepare('INSERT INTO sr_history(pseudo,sr,wins,losses,at) VALUES(?,?,?,?,?)').run(pseudo, int(h.sr), int(h.wins), int(h.losses), date(h.at) || date(Date.now())); n.historique++; }
    }
    for (const m of matches) {
      const code = str(m.code, 20); if (!code) continue;
      const kind = ['classe', 'rapide', 'privee'].includes(m.kind) ? m.kind : null;
      db.prepare(`INSERT INTO matches(code,kind,status,winner_team,host,first_seen,ended_seen,source) VALUES(?,?,?,?,?,COALESCE(?,datetime('now')),COALESCE(?,datetime('now')),?)
        ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, status=excluded.status, winner_team=excluded.winner_team, host=excluded.host, ended_seen=excluded.ended_seen`)
        .run(code, kind, m.status || 'termine', int(m.winner_team), str(m.host, 40), date(m.started_at || m.ended_at), date(m.ended_at), source); n.parties++;
      for (const p of m.players || []) {
        const ps = str(p.pseudo, 40); if (!ps) continue;
        db.prepare('INSERT OR IGNORE INTO players(pseudo,source) VALUES(?,?)').run(ps, source);
        db.prepare('INSERT OR REPLACE INTO match_players(code,pseudo,team,sr_before,sr_after) VALUES(?,?,?,?,?)').run(code, ps, int(p.team), int(p.sr_before), int(p.sr_after));
      }
    }
  })();
  return n;
}
module.exports = { importData, parseCsv, csvToJson };

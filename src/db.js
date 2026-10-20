// Base SQLite de l'agent (indépendante du site). Sur Render free, le disque est éphémère : les données repartent de zéro à chaque redéploiement.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function open(file = process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'anticheat.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS players(pseudo TEXT PRIMARY KEY, platform TEXT, member_since TEXT, first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  sr INTEGER, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, last_api TEXT, last_profile TEXT, source TEXT DEFAULT 'collecte');
CREATE TABLE IF NOT EXISTS linked(pseudo TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL, verified INTEGER DEFAULT 0, PRIMARY KEY(pseudo, provider));
CREATE INDEX IF NOT EXISTS ix_linked_acc ON linked(provider, account_id);
CREATE TABLE IF NOT EXISTS sr_history(pseudo TEXT NOT NULL, sr INTEGER NOT NULL, wins INTEGER, losses INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_srh ON sr_history(pseudo, at);
CREATE TABLE IF NOT EXISTS matches(code TEXT PRIMARY KEY, kind TEXT, status TEXT, winner_team INTEGER, host TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')), ended_seen TEXT, source TEXT DEFAULT 'collecte');
CREATE TABLE IF NOT EXISTS match_players(code TEXT NOT NULL REFERENCES matches(code) ON DELETE CASCADE, pseudo TEXT NOT NULL, team INTEGER,
  sr_before INTEGER, sr_after INTEGER, PRIMARY KEY(code, pseudo));
CREATE TABLE IF NOT EXISTS scores(pseudo TEXT PRIMARY KEY, score INTEGER NOT NULL, reasons TEXT NOT NULL, summary TEXT, computed_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL, score INTEGER NOT NULL, reasons TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen INTEGER DEFAULT 0, notified TEXT);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, pseudo TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('innocent','surveiller','sanctionne')),
  note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);
  db.kvGet = k => db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
  db.kvSet = (k, v) => db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(k, String(v));
  return db;
}

// Jeu de données complet pour les détecteurs (fonctions pures)
function dataset(db) {
  const players = db.prepare('SELECT * FROM players').all();
  const linked = db.prepare('SELECT * FROM linked').all();
  const history = db.prepare('SELECT * FROM sr_history ORDER BY at').all();
  const matches = db.prepare("SELECT * FROM matches WHERE status='termine' ORDER BY COALESCE(ended_seen, first_seen), code").all();
  const mp = db.prepare('SELECT * FROM match_players').all();
  const byCode = {}; mp.forEach(p => (byCode[p.code] ||= []).push(p));
  matches.forEach(m => { m.players = byCode[m.code] || []; });
  return { players, linked, history, matches };
}
module.exports = { open, dataset };

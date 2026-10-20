const test = require('node:test'), assert = require('node:assert');
const { open, dataset } = require('../src/db'), { importData } = require('../src/importer'), S = require('../src/synthetic'), engine = require('../src/engine'), P = require('../src/parse');
test('import JSON synthétique + analyse → alertes créées', async () => {
  const db = open(':memory:'); S.load(db, S.build());
  const ds = dataset(db); assert.ok(ds.players.length > 50 && ds.matches.length > 100);
  await engine.run(db);
  const al = db.prepare('SELECT DISTINCT pseudo FROM alerts').all().map(r => r.pseudo);
  for (const p of ['NewKid', 'ShadowFox', 'TradeA']) assert.ok(al.includes(p), p);
  assert.ok(!al.some(p => /\d$/.test(p) && p !== 'Shad0wFox2'));
});
test('import CSV joueurs', () => {
  const db = open(':memory:');
  importData(db, 'pseudo,sr,wins,losses,member_since\nAlpha,1200,10,5,2026-01-02\n', 'csv');
  assert.equal(db.prepare('SELECT sr FROM players WHERE pseudo=?').get('Alpha').sr, 1200);
});
test('parse classement', () => {
  const rows = P.leaderboard('<tr><td class="pos">1</td><td><a href="/joueurs/Bob">Bob</a></td><td>Or</td><td><b>1350</b></td><td>12 / 3</td></tr>');
  assert.equal(rows[0].pseudo, 'Bob'); assert.equal(rows[0].sr, 1350);
});

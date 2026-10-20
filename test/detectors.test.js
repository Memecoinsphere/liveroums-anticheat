const test = require('node:test'), assert = require('node:assert');
const S = require('../src/synthetic'), D = require('../src/detectors');
const ds = S.build(), R = D.score(ds, ds.now), sc = p => R[p]?.score ?? 0, dets = p => new Set((R[p]?.reasons || []).map(r => r.detecteur));

test('smurf : compte récent, winrate anormal, SR qui grimpe → score élevé', () => {
  assert.ok(sc('NewKid') >= 60, `score ${sc('NewKid')}`); assert.ok(dets('NewKid').has('smurf'));
  assert.ok((D.smurf(ds, ds.now).NewKid || []).some(r => /\d+ j/.test(r.texte)));
});
test('multi-compte : même ID lié + même Discord + pseudos proches + toujours ensemble', () => {
  for (const p of ['ShadowFox', 'Shad0wFox2']) { assert.ok(sc(p) >= 80, `${p} ${sc(p)}`); assert.ok(dets(p).has('multi-compte')); }
  assert.ok(R.ShadowFox.reasons.some(r => r.lie_a === 'Shad0wFox2' && /Discord/.test(r.texte)));
});
test('échange de victoires : résultats strictement alternés', () => {
  for (const p of ['TradeA', 'TradeB']) { assert.ok(sc(p) >= 60, `${p} ${sc(p)}`); assert.ok(R[p].reasons.some(r => /altern/i.test(r.texte))); }
});
test('farm : l’hôte gagne toujours en privé contre le même adversaire', () => {
  assert.ok(sc('Farmer') >= 50); assert.ok(sc('Feeder') >= 20 && sc('Feeder') < sc('Farmer'));
});
test('boosting quatuor : compte faible porté par 3 joueurs forts', () => {
  assert.ok(sc('Carried') >= 25); assert.ok(sc('Kraken') < 20);
});
test('joueurs normaux : score faible (aucun faux positif)', () => {
  const normals = ds.players.filter(p => /\d$/.test(p.pseudo) && p.pseudo !== 'Shad0wFox2');
  assert.ok(normals.length >= 40);
  for (const p of normals) assert.ok(sc(p.pseudo) < 20, `${p.pseudo} ${sc(p.pseudo)} ${JSON.stringify(R[p.pseudo]?.reasons)}`);
});
test('jeu sans scénario de triche → personne au-dessus de 20', () => {
  const clean = S.build({ scenarios: [], seed: 99 }), r = D.score(clean, clean.now);
  assert.ok(Object.values(r).every(x => x.score < 20));
});
test('score borné à 100 et raisons expliquées', () => {
  for (const x of Object.values(R)) { assert.ok(x.score >= 0 && x.score <= 100); for (const r of x.reasons) assert.ok(r.texte.length > 10 && !r.texte.includes('§')); }
});
test('outils : similarité de pseudo et espérance Elo', () => {
  assert.ok(D.pseudoSim('ShadowFox', 'Shad0wFox2') >= 0.8); assert.ok(D.pseudoSim('Kraken', 'Zephyr') < 0.5);
  assert.ok(Math.abs(D.expected(1000, 1000) - 0.5) < 1e-9);
});

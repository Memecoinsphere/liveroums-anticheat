// Détecteurs (fonctions pures, sans effet de bord) : chaque détecteur renvoie des raisons {detecteur, points, texte} par joueur.
// Aucune donnée in-game : uniquement résultats, SR et comptes publics. Ne sanctionne jamais : l'admin décide.
const DAY = 864e5;
const START_SR = 1000;

// ---------- Outils statistiques ----------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400)); // probabilité Elo que a batte b
// z-score binomial du nombre de victoires par rapport à une probabilité p
const binomZ = (w, n, p = 0.5) => n ? (w - n * p) / Math.sqrt(n * p * (1 - p)) : 0;
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const norm = p => String(p).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[0o]/g, 'o').replace(/[1il|]/g, 'i').replace(/[^a-z]/g, '');
// Similarité de pseudos (0..1) : squelette sans chiffres/séparateurs, distance de Levenshtein normalisée
function pseudoSim(a, b) {
  const x = norm(a), y = norm(b); if (x.length < 3 || y.length < 3) return 0;
  if (x === y) return 1;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
}
// Âge du compte en jours (date « membre depuis » publique, sinon première observation)
function ageDays(p, now) {
  const d = p.member_since ? new Date(p.member_since) : p.first_seen ? new Date(String(p.first_seen).replace(' ', 'T') + (String(p.first_seen).includes('Z') ? '' : 'Z')) : null;
  return d && !isNaN(d) ? Math.max(0, (now - d) / DAY) : null;
}
const R = (detecteur, points, texte) => ({ detecteur, points: Math.round(points), texte });

// ---------- 1. Smurfs ----------
function smurf(ds, now = Date.now()) {
  const out = {};
  const ranked = ds.players.filter(p => (p.wins || 0) + (p.losses || 0) >= 5);
  const wrs = ranked.map(p => p.wins / (p.wins + p.losses)), popWr = wrs.length >= 5 ? mean(wrs) : 0.5, popSd = Math.max(0.05, std(wrs) || 0.12);
  const hist = {}; ds.history.forEach(h => (hist[h.pseudo] ||= []).push(h));
  for (const p of ds.players) {
    const n = (p.wins || 0) + (p.losses || 0), wr = n ? p.wins / n : 0, age = ageDays(p, now), r = [];
    const zb = binomZ(p.wins || 0, n), zp = n ? (wr - popWr) / popSd : 0;
    if (age != null && age <= 14 && n >= 10 && wr >= 0.75) r.push(R('smurf', 30 + Math.min(10, (wr - 0.75) * 40), `Compte récent (${Math.round(age)} j) avec ${Math.round(wr * 100)} % de victoires sur ${n} parties classées.`));
    if (age != null && age <= 30 && (p.sr || 0) >= 1350) r.push(R('smurf', 20, `SR ${p.sr} (Diamant ou plus) atteint en ${Math.round(age)} jours d'ancienneté.`));
    if (n >= 15 && zb >= 3) r.push(R('smurf', 15, `Taux de victoire statistiquement anormal : z = ${zb.toFixed(1)} (binomial, p = 0,5) et ${zp.toFixed(1)} écarts-types au-dessus de la moyenne des joueurs.`));
    // Vitesse de progression du SR : gain moyen par partie et par jour, à partir de l'historique observé (ou depuis le SR de départ)
    const h = hist[p.pseudo] || [];
    const first = h.length ? h[0] : null, last = h.length ? h[h.length - 1] : null;
    const games = first && last ? ((last.wins || 0) + (last.losses || 0)) - ((first.wins || 0) + (first.losses || 0)) : 0;
    const gain = first && last ? last.sr - first.sr : 0;
    if (games >= 8 && gain / games >= 18) r.push(R('smurf', 25, `Progression de SR très rapide : +${gain} SR en ${games} parties observées (+${(gain / games).toFixed(1)} / partie, K = 32).`));
    else if (!h.length && n >= 8 && age != null && age <= 30 && ((p.sr || START_SR) - START_SR) / n >= 18) r.push(R('smurf', 20, `+${p.sr - START_SR} SR depuis le départ (${START_SR}) en ${n} parties (${(((p.sr - START_SR) / n)).toFixed(1)} / partie).`));
    if (first && last && last.sr - first.sr >= 250) {
      const days = Math.max(1 / 24, (new Date(last.at.replace(' ', 'T') + 'Z') - new Date(first.at.replace(' ', 'T') + 'Z')) / DAY);
      if ((last.sr - first.sr) / days >= 150) r.push(R('smurf', 10, `Vitesse de gain : +${Math.round((last.sr - first.sr) / days)} SR / jour.`));
    }
    if (r.length) out[p.pseudo] = r;
  }
  return out;
}

// ---------- 2. Multi-comptes ----------
function multiAccount(ds, now = Date.now()) {
  const out = {}, pair = {}; const add = (a, b, pts, txt) => { const k = [a, b].sort().join('\u0000'); (pair[k] ||= { a, b, r: [] }).r.push(R('multi-compte', pts, txt)); };
  // Même identifiant de plateforme liée (Activision, PSN, Xbox, Battle.net, Steam) ou même Discord
  const byAcc = {}; ds.linked.forEach(l => (byAcc[l.provider + '\u0000' + String(l.account_id).trim().toLowerCase()] ||= []).push(l));
  for (const list of Object.values(byAcc)) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
    add(list[i].pseudo, list[j].pseudo, list[i].provider.toLowerCase().includes('discord') ? 55 : 50, `Même compte ${list[i].provider} lié (« ${list[i].account_id} ») que §.`);
  const P = ds.players, byP = Object.fromEntries(P.map(p => [p.pseudo, p]));
  // Co-présence dans les parties : ensemble / l'un contre l'autre
  const together = {}, against = {};
  for (const m of ds.matches) for (let i = 0; i < m.players.length; i++) for (let j = i + 1; j < m.players.length; j++) {
    const x = m.players[i], y = m.players[j], k = [x.pseudo, y.pseudo].sort().join('\u0000');
    if (x.team === y.team) together[k] = (together[k] || 0) + 1; else against[k] = (against[k] || 0) + 1;
  }
  const games = {}; ds.matches.forEach(m => m.players.forEach(p => { games[p.pseudo] = (games[p.pseudo] || 0) + 1; }));
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j], k = [a.pseudo, b.pseudo].sort().join('\u0000');
    const sim = pseudoSim(a.pseudo, b.pseudo);
    const sameDay = a.member_since && b.member_since && Math.abs(new Date(a.member_since) - new Date(b.member_since)) <= DAY;
    const co = (together[k] || 0) + (against[k] || 0), minG = Math.min(games[a.pseudo] || 0, games[b.pseudo] || 0);
    const coRatio = minG ? co / minG : 0;
    const strong = sim >= 0.8 || sameDay;
    // la similarité de pseudo seule ne suffit jamais (beaucoup de « Ghost12 ») : il faut un second indice
    if (sim >= 0.8 && (sameDay || coRatio >= 0.6)) add(a.pseudo, b.pseudo, 15, `Pseudo très proche de § (similarité ${Math.round(sim * 100)} %).`);
    if (sameDay && (sim >= 0.6 || coRatio >= 0.7)) add(a.pseudo, b.pseudo, 10, `Compte créé à moins de 24 h d'écart de §.`);
    if (co >= 5 && coRatio >= 0.8 && strong) add(a.pseudo, b.pseudo, 15, `Joue presque toujours avec ou contre § (${co} parties communes, ${Math.round(coRatio * 100)} % de ses parties).`);
  }
  for (const { a, b, r } of Object.values(pair)) {
    const tot = r.reduce((s, x) => s + x.points, 0); if (tot < 15) continue;
    for (const [me, other] of [[a, b], [b, a]]) (out[me] ||= []).push(...r.map(x => ({ ...x, texte: x.texte.replace('§', other), lie_a: other })));
  }
  return out;
}

// ---------- 3. Matchs arrangés / win trading / farm de points / boosting ----------
function arranged(ds) {
  const out = {}; const push = (p, pts, txt) => (out[p] ||= []).push(R('match-arrange', pts, txt));
  const series = {}; // paire adverse -> suite de vainqueurs
  const hostWins = {}; // hôte -> adversaire -> {n, w}
  const surprise = {}; // joueur -> [actual - expected]
  const boost = {}; // joueur faible -> clé des coéquipiers -> n
  for (const m of ds.matches) {
    if (!m.winner_team) continue;
    const t1 = m.players.filter(p => p.team === 1), t2 = m.players.filter(p => p.team === 2); if (!t1.length || !t2.length) continue;
    const avg = t => mean(t.map(p => p.sr_before ?? START_SR));
    const e1 = expected(avg(t1), avg(t2));
    for (const p of m.players) (surprise[p.pseudo] ||= []).push({ act: p.team === m.winner_team ? 1 : 0, exp: p.team === 1 ? e1 : 1 - e1, ranked: m.kind === 'classe' });
    // Face-à-face significatifs seulement : petits formats (1v1 / 2v2) ou parties privées. En classé 4v4 en solo, c'est le matchmaking qui apparie.
    const duel = t1.length <= 2 || m.kind === 'privee';
    if (duel) for (const a of t1) for (const b of t2) {
      const [x, y] = [a.pseudo, b.pseudo].sort(), k = x + '\u0000' + y;
      (series[k] ||= { x, y, w: [], kinds: [] }).w.push(m.winner_team === (a.pseudo === x ? 1 : 2) ? x : y); series[k].kinds.push(m.kind);
    }
    if (m.host && (t1.length <= 2 || m.kind === 'privee')) { // en 4v4 classé, l'hôte est désigné par le matchmaking
      const hp = m.players.find(p => p.pseudo === m.host);
      if (hp) for (const o of m.players.filter(p => p.team !== hp.team)) { const s = ((hostWins[m.host] ||= {})[o.pseudo] ||= { n: 0, w: 0 }); s.n++; if (m.winner_team === hp.team) s.w++; }
    }
    if (m.kind === 'classe') for (const t of [t1, t2]) {
      if (t.length < 4) continue;
      const srs = t.map(p => p.sr_before ?? START_SR), lo = Math.min(...srs), others = t.filter(p => (p.sr_before ?? START_SR) !== lo);
      if (others.length && mean(others.map(p => p.sr_before ?? START_SR)) - lo >= 400) {
        const low = t.find(p => (p.sr_before ?? START_SR) === lo).pseudo, key = others.map(p => p.pseudo).sort().join(', ');
        const b = ((boost[low] ||= {})[key] ||= { n: 0, w: 0 }); b.n++; if (m.winner_team === t[0].team) b.w++;
      }
    }
  }
  for (const { x, y, w, kinds } of Object.values(series)) {
    const n = w.length; if (n < 5) continue;
    const alternations = w.slice(1).filter((v, i) => v !== w[i]).length, wx = w.filter(v => v === x).length, wy = n - wx;
    const priv = kinds.filter(k => k === 'privee').length;
    if (alternations >= n - 1 && n >= 6) for (const [me, o] of [[x, y], [y, x]]) push(me, 35, `Résultats strictement alternés contre ${o} sur ${n} parties (${w.join(' → ')}) : schéma typique d'échange de victoires.`);
    else if (Math.max(wx, wy) / n >= 0.85) { // p(≥85 % sur ≥5 parties | hasard) < 3 %
      const [win, lose] = wx >= wy ? [x, y] : [y, x];
      push(win, 25 + Math.min(10, n - 4) + (priv * 2 >= n ? 10 : 0), `A battu ${lose} ${Math.max(wx, wy)} fois sur ${n} face-à-face${priv ? ` (dont ${priv} en partie privée)` : ''} : possible farm de points.`);
      push(lose, 15 + (priv * 2 >= n ? 10 : 0), `A perdu ${Math.max(wx, wy)} fois sur ${n} contre ${win}${priv ? ` (dont ${priv} en partie privée)` : ''} : possible compte « nourrisseur ».`);
    }
  }
  for (const [h, opp] of Object.entries(hostWins)) for (const [o, s] of Object.entries(opp))
    if (s.n >= 3 && s.w / s.n >= 0.8) push(h, 20, `En tant qu'hôte, a déclaré la victoire de son équipe ${s.w}/${s.n} fois contre ${o}.`);
  for (const [p, arr] of Object.entries(surprise)) {
    if (arr.length < 8) continue;
    const act = arr.reduce((s, x) => s + x.act, 0), exp = arr.reduce((s, x) => s + x.exp, 0), v = arr.reduce((s, x) => s + x.exp * (1 - x.exp), 0);
    const z = v ? (act - exp) / Math.sqrt(v) : 0;
    if (z >= 2.5) push(p, 20, `Victoires très au-dessus de l'attendu Elo : ${act} gagnées pour ${exp.toFixed(1)} attendues sur ${arr.length} parties (z = ${z.toFixed(1)}).`);
  }
  for (const [low, ks] of Object.entries(boost)) for (const [k, b] of Object.entries(ks)) if (b.n >= 3) {
    push(low, 25 + 5 * Math.min(3, b.n - 3), `Compte à faible SR joué ${b.n} fois en quatuor avec des coéquipiers à +400 SR (${k}), ${b.w} victoires : possible boosting.`);
    for (const m of k.split(', ')) push(m, 8, `Fait partie d'un quatuor qui porte régulièrement un compte à faible SR (${low}).`);
  }
  return out;
}

// ---------- Agrégation du score 0-100 ----------
function score(ds, now = Date.now()) {
  const parts = [smurf(ds, now), multiAccount(ds, now), arranged(ds)], res = {};
  const names = new Set([...ds.players.map(p => p.pseudo), ...parts.flatMap(o => Object.keys(o))]);
  for (const p of names) {
    const reasons = parts.flatMap(o => o[p] || []).sort((a, b) => b.points - a.points);
    // Par détecteur, on additionne avec rendement décroissant (×0,6 à chaque signal supplémentaire) pour éviter qu'un seul signal répété ne sature le score
    const byDet = {}; reasons.forEach(r => (byDet[r.detecteur] ||= []).push(r.points));
    const s = Object.values(byDet).reduce((sum, pts) => sum + pts.sort((a, b) => b - a).reduce((t, x, i) => t + x * 0.6 ** i, 0), 0);
    res[p] = { pseudo: p, score: Math.min(100, Math.round(s)), reasons };
  }
  return res;
}
module.exports = { smurf, multiAccount, arranged, score, pseudoSim, binomZ, expected, ageDays };

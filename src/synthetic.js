// Données synthétiques reproductibles (tests unitaires + démo du tableau de bord)
const DAY = 864e5;
function rng(seed = 42) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const iso = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const dayStr = t => new Date(t).toISOString().slice(0, 10);

function build({ now = Date.parse('2026-10-20T08:00:00Z'), normals = 40, scenarios = ['smurf', 'multi', 'trade', 'farm', 'boost'], seed = 7 } = {}) {
  const r = rng(seed), players = [], linked = [], history = [], matches = []; let mc = 0, t = now - 20 * DAY;
  const P = {}; const add = (pseudo, o) => { const p = { pseudo, platform: 'PC', member_since: dayStr(now - (o.age ?? 200) * DAY), first_seen: iso(now - 20 * DAY), sr: o.sr ?? 1000, wins: o.wins ?? 0, losses: o.losses ?? 0 }; players.push(p); P[pseudo] = p; return p; };
  const NAMES = ['Ghost', 'Viper', 'Nova', 'Raptor', 'Echo', 'Blaze', 'Hunter', 'Storm', 'Kilo', 'Wolf', 'Titan', 'Onyx', 'Falcon', 'Reaper', 'Spectre', 'Havoc', 'Cobra', 'Drift', 'Jinx', 'Rook'];
  const SUFF = ['Prime', 'Ops', 'Tac', 'Zero', 'Unit', 'Line', 'Core', 'Shift', 'Pulse', 'Grid'];
  for (let i = 0; i < normals; i++) add(`${NAMES[i % 20]}${SUFF[Math.floor(i / 2) % 10]}${i}`, { age: 60 + Math.floor(r() * 400), sr: 900 + Math.floor(r() * 400) });
  const linkAll = () => players.forEach((p, i) => { if (!linked.some(l => l.pseudo === p.pseudo)) linked.push({ pseudo: p.pseudo, provider: 'Activision ID', account_id: `${p.pseudo}#${1000 + i}`, verified: 0 }); });
  const exp = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
  const play = (t1, t2, { kind = 'classe', winner, host } = {}) => {
    const avg = t => t.reduce((s, x) => s + P[x].sr, 0) / t.length, e1 = exp(avg(t1), avg(t2));
    const w = winner ?? (r() < e1 ? 1 : 2), d = Math.max(1, Math.round(32 * (1 - (w === 1 ? e1 : 1 - e1))));
    t += 3600e3 * (0.5 + r());
    const m = { code: 'M' + String(++mc).padStart(5, '0'), kind, status: 'termine', winner_team: w, host: host ?? t1[0], first_seen: iso(t), ended_seen: iso(t + 9e5), players: [] };
    for (const [team, ids] of [[1, t1], [2, t2]]) for (const id of ids) {
      const p = P[id], before = p.sr, won = team === w, delta = kind === 'classe' ? (won ? d : -d) : 0;
      p.sr += delta; won ? p.wins++ : p.losses++;
      m.players.push({ code: m.code, pseudo: id, team, sr_before: before, sr_after: kind === 'classe' ? p.sr : null });
    }
    matches.push(m);
  };
  const normalsList = players.map(p => p.pseudo);
  const pick = (n, excl = []) => { const pool = normalsList.filter(x => !excl.includes(x)), out = []; while (out.length < n) { const x = pool[Math.floor(r() * pool.length)]; if (!out.includes(x)) out.push(x); } return out; };
  for (let i = 0; i < 70; i++) { const ids = pick(8); play(ids.slice(0, 4), ids.slice(4)); }
  if (scenarios.includes('smurf')) { // compte de 5 jours, 22 V / 3 D, SR qui grimpe très vite
    const s = add('NewKid', { age: 5, sr: 1000 });
    history.push({ pseudo: 'NewKid', sr: 1000, wins: 0, losses: 0, at: iso(now - 5 * DAY) });
    for (let i = 0; i < 25; i++) { const ids = pick(7); play(['NewKid', ...ids.slice(0, 3)], ids.slice(3), { winner: i % 8 === 7 ? 2 : 1 }); }
    s.sr = Math.max(s.sr, 1420); history.push({ pseudo: 'NewKid', sr: s.sr, wins: s.wins, losses: s.losses, at: iso(now - DAY) });
  }
  if (scenarios.includes('multi')) { // même Activision ID + même Discord, créés le même jour, pseudos proches, jouent ensemble
    add('ShadowFox', { age: 12, sr: 1100 }); add('Shad0wFox2', { age: 12, sr: 1050 });
    linked.push({ pseudo: 'ShadowFox', provider: 'Activision ID', account_id: 'ShadowFox#4471', verified: 0 }, { pseudo: 'Shad0wFox2', provider: 'Activision ID', account_id: 'shadowfox#4471', verified: 0 },
      { pseudo: 'ShadowFox', provider: 'Discord', account_id: 'Shadow (@shadowfox)', verified: 1 }, { pseudo: 'Shad0wFox2', provider: 'Discord', account_id: 'Shadow (@shadowfox)', verified: 1 });
    for (let i = 0; i < 6; i++) { const ids = pick(6); play(['ShadowFox', 'Shad0wFox2', ...ids.slice(0, 2)], ids.slice(2)); }
  }
  if (scenarios.includes('trade')) { // échange de victoires strictement alterné
    add('TradeA', { age: 90, sr: 1150 }); add('TradeB', { age: 95, sr: 1140 });
    for (let i = 0; i < 8; i++) play(['TradeA'], ['TradeB'], { kind: 'rapide', winner: i % 2 ? 2 : 1, host: i % 2 ? 'TradeB' : 'TradeA' });
  }
  if (scenarios.includes('farm')) { // l'hôte gagne toujours contre le même adversaire en privé
    add('Farmer', { age: 120, sr: 1000 }); add('Feeder', { age: 30, sr: 1000 });
    for (let i = 0; i < 7; i++) play(['Farmer'], ['Feeder'], { kind: 'privee', winner: 1, host: 'Farmer' });
  }
  if (scenarios.includes('boost')) { // compte faible porté par 3 joueurs à haut SR en quatuor
    add('Carried', { age: 40, sr: 720 }); ['Kraken', 'Mamba', 'Zephyr'].forEach((n, i) => add(n, { age: 300 + 40 * i, sr: 1380 }));
    for (let i = 0; i < 4; i++) { const ids = pick(4); play(['Kraken', 'Mamba', 'Zephyr', 'Carried'], ids, { winner: 1 }); P.Carried.sr = 720 + i * 30; }
  }
  linkAll();
  return { players, linked, history, matches, now };
}
// Écrit le jeu de données dans la base de l'agent
function load(db, ds) {
  const { importData } = require('./importer');
  importData(db, {
    players: ds.players.map(p => ({ ...p, linked: ds.linked.filter(l => l.pseudo === p.pseudo), sr_history: ds.history.filter(h => h.pseudo === p.pseudo) })),
    matches: ds.matches.map(m => ({ ...m, started_at: m.first_seen.replace(' ', 'T') + 'Z', ended_at: m.ended_seen.replace(' ', 'T') + 'Z' })),
  }, 'synthetique');
}
module.exports = { build, load };

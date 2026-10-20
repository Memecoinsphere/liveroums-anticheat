// Analyse du HTML/JSON public de LiveRoums Arena (aucune route privée, aucune connexion)
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

// /classement : top 100 classé (pseudo, SR, victoires, défaites)
function leaderboard(html) {
  const out = [], re = /<tr[^>]*><td class="pos">\d+<\/td><td>([\s\S]*?)<\/td><td>[\s\S]*?<\/td><td><b>(\d+)<\/b><\/td><td>(\d+) \/ (\d+)<\/td>/g;
  let m; while ((m = re.exec(html))) { const p = /href="\/joueurs\/([^"]+)"/.exec(m[1]); if (p) out.push({ pseudo: dec(p[1]), sr: +m[2], wins: +m[3], losses: +m[4] }); }
  return out;
}
// /joueurs/:pseudo : plateforme, date d'inscription, comptes liés, V/D Call of Duty
function profile(html) {
  const since = /membre depuis (\d{2})\/(\d{2})\/(\d{4})/.exec(html), plat = /<p class="muted">([^<·]+?) · membre depuis/.exec(html);
  const linked = []; const re = /<span class="link-chip">[^<]*<b>([^<]+)<\/b> ([\s\S]*?) <i class="ver( ok)?">/g; let m;
  while ((m = re.exec(html))) linked.push({ provider: unesc(m[1]).trim(), account_id: unesc(m[2]).trim(), verified: m[3] ? 1 : 0 });
  const wl = /Call of Duty<\/span>[\s\S]*?<b>(\d+)<\/b><\/span><small class="muted">(\d+) V · (\d+) D<\/small>/.exec(html);
  return { member_since: since ? `${since[3]}-${since[2]}-${since[1]}` : null, platform: plat ? unesc(plat[1]).trim() : null, linked,
    sr: wl ? +wl[1] : null, wins: wl ? +wl[2] : null, losses: wl ? +wl[3] : null };
}
// /parties/:code (HTML) : type de partie et hôte (non présents dans l'API JSON)
function matchPage(html) {
  const kind = /🏆 Classé<\/span>/.test(html) ? 'classe' : /Privée · sans SR/.test(html) ? 'privee' : /Partie rapide · sans SR/.test(html) ? 'rapide' : null;
  let host = null; const li = html.split('<li>').find(x => x.includes('👑 hôte')); if (li) { const h = /href="\/joueurs\/([^"]+)"/.exec(li); if (h) host = dec(h[1]); }
  return { kind, host };
}
module.exports = { leaderboard, profile, matchPage, unesc };

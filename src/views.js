// Gabarits HTML (français, style néon cohérent avec le site)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEC = { innocent: ['Innocent', 'ok'], surveiller: ['À surveiller', 'warn'], sanctionne: ['Sanctionné côté site', 'err'] };
const DET = { smurf: '🧒 Smurf', 'multi-compte': '👥 Multi-compte', 'match-arrange': '🤝 Match arrangé / farm' };
const level = s => s >= 80 ? 'crit' : s >= 60 ? 'high' : s >= 30 ? 'mid' : 'low';
const fmt = s => s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|\+/.test(s) ? '' : 'Z')).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }) : '—';
function layout(title, body, { auth = true, flash } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Anti-Triche LiveRoums</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="nav"><a class="logo" href="/">🛡️ LiveRoums<span>Anti-Triche</span></a>${auth ? `<nav><a href="/">Tableau de bord</a><a href="/alertes">Alertes</a><a href="/import">Import</a><a href="/signaux">Signaux</a>
<form method="post" action="/deconnexion"><button class="btn ghost sm">Déconnexion</button></form></nav>` : ''}</header>
${flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.msg)}</div>` : ''}<main>${body}</main>
<footer><p>Agent d'aide à la décision : aucune sanction automatique. Données publiques uniquement (résultats, SR, comptes).</p></footer></body></html>`;
}
const scoreBadge = s => `<span class="score ${level(s)}">${s}</span>`;
const decBadge = d => d ? `<span class="dec ${DEC[d][1]}">${DEC[d][0]}</span>` : '<span class="muted">—</span>';
const reasonsHtml = rs => rs.length ? `<ul class="reasons">${rs.map(r => `<li><span class="det">${esc(DET[r.detecteur] || r.detecteur)}</span> <b>+${r.points}</b> ${esc(r.texte)}${r.lie_a ? ` <a href="/joueurs/${encodeURIComponent(r.lie_a)}">→ ${esc(r.lie_a)}</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Aucun signal.</p>';
module.exports = { esc, layout, scoreBadge, decBadge, reasonsHtml, DEC, DET, fmt, level };

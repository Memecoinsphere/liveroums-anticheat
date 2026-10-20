// Moteur : calcule les scores, crée les alertes (jamais de sanction automatique), notifie (Discord / email, désactivés par défaut)
const D = require('./detectors');
const { dataset } = require('./db');

const THRESHOLD = () => Math.max(1, Math.min(100, +process.env.ALERT_THRESHOLD || 50));

async function notify(alert, log = console) {
  const out = [];
  const text = `🚨 LiveRoums Anti-Triche — ${alert.pseudo} : score ${alert.score}/100\n` + alert.reasons.slice(0, 4).map(r => `• ${r.texte}`).join('\n') + `\nÀ vérifier par un admin (aucune sanction automatique).`;
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10000) });
      out.push(r.ok ? 'discord' : 'discord:échec');
    } catch { out.push('discord:échec'); }
  }
  if (process.env.SMTP_URL && process.env.ALERT_EMAIL_TO) {
    try {
      const tr = require('nodemailer').createTransport(process.env.SMTP_URL);
      await tr.sendMail({ from: process.env.ALERT_EMAIL_FROM || 'anticheat@liveroums.gg', to: process.env.ALERT_EMAIL_TO, subject: `Alerte anti-triche : ${alert.pseudo} (${alert.score}/100)`, text });
      out.push('email');
    } catch (e) { log.warn('Email : ' + e.message); out.push('email:échec'); }
  }
  return out;
}
// Résumé optionnel par LLM (API compatible OpenAI) — uniquement si LLM_API_KEY est défini
async function llmSummary(r) {
  if (!process.env.LLM_API_KEY) return null;
  try {
    const res = await fetch(process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', max_tokens: 160, messages: [
        { role: 'system', content: "Tu aides un administrateur de tournois Call of Duty. Résume en 2 phrases, en français et de façon neutre, les signaux suivants. Ne conclus jamais à la culpabilité : ce sont des indices à vérifier." },
        { role: 'user', content: `Joueur ${r.pseudo}, score ${r.score}/100.\n` + r.reasons.map(x => `- (${x.detecteur}, ${x.points}) ${x.texte}`).join('\n') }] }) });
    const j = await res.json(); return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}
async function run(db, { now = Date.now(), log = console } = {}) {
  const res = D.score(dataset(db), now), th = THRESHOLD(), created = [];
  for (const r of Object.values(res)) {
    const prev = db.prepare('SELECT score FROM scores WHERE pseudo=?').get(r.pseudo);
    db.prepare("INSERT OR REPLACE INTO scores(pseudo,score,reasons,summary,computed_at) VALUES(?,?,?,(SELECT summary FROM scores WHERE pseudo=?),datetime('now'))").run(r.pseudo, r.score, JSON.stringify(r.reasons), r.pseudo);
    // Nouvelle alerte si le seuil est franchi (ou si le score augmente de 15+ au-dessus du seuil), sauf joueur déjà classé « innocent » avec un score inchangé
    const rev = db.prepare('SELECT decision FROM reviews WHERE pseudo=? ORDER BY id DESC LIMIT 1').get(r.pseudo);
    const lastAlert = db.prepare('SELECT score FROM alerts WHERE pseudo=? ORDER BY id DESC LIMIT 1').get(r.pseudo);
    if (r.score >= th && (!lastAlert || r.score >= lastAlert.score + 15) && !(rev?.decision === 'innocent' && prev && r.score <= prev.score)) {
      const summary = await llmSummary(r); if (summary) db.prepare('UPDATE scores SET summary=? WHERE pseudo=?').run(summary, r.pseudo);
      const id = db.prepare('INSERT INTO alerts(pseudo,score,reasons) VALUES(?,?,?)').run(r.pseudo, r.score, JSON.stringify(r.reasons)).lastInsertRowid;
      const sent = await notify(r, log); if (sent.length) db.prepare('UPDATE alerts SET notified=? WHERE id=?').run(sent.join(','), id);
      created.push({ id, ...r });
    }
  }
  db.kvSet('last_scan', new Date(now).toISOString());
  return { scored: Object.keys(res).length, alerts: created.length };
}
module.exports = { run, notify, THRESHOLD };

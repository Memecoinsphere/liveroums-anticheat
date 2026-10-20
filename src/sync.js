// Synchronisation automatique avec l'export admin du site : GET /api/admin/anticheat-export?since= (Bearer SITE_EXPORT_TOKEN)
// Source principale quand le jeton est défini ; la collecte publique ne sert alors que de secours.
const { importData } = require('./importer');
const engine = require('./engine');

const MAX_BACKOFF = 3600e3, OVERLAP = 120e3; // chevauchement de 2 min sur l'incrémental (horloges / parties en cours)
function createSync(db, { base = process.env.SITE_URL || 'https://liveroums-arena.onrender.com', token = process.env.SITE_EXPORT_TOKEN, intervalS = +process.env.EXPORT_INTERVAL_S || 300,
  fetchImpl = (...a) => fetch(...a), analyse = d => engine.run(d), log = console, now = () => Date.now() } = {}) {
  const interval = Math.max(60, intervalS) * 1000; // site : 6 req/min/IP → 1/min maximum ici
  const st = { enabled: !!token, running: false, fails: 0, last_ok: null, last_try: null, last_error: null, last_counts: null, last_mode: null, last_alerts: 0, next_at: null, cursor: null, total_syncs: 0 };
  let timer = null, startupFull = true, current = null;
  const save = () => db.kvSet('sync_status', JSON.stringify(st));

  function backoff(kind, retryAfter) {
    st.fails++;
    if (kind === 'rate' && retryAfter) return Math.min(MAX_BACKOFF, Math.max(interval, retryAfter * 1000));
    if (kind === 'auth') return Math.min(MAX_BACKOFF, 15 * 60e3 * st.fails); // jeton refusé / export désactivé : inutile d'insister
    return Math.min(MAX_BACKOFF, interval * 2 ** Math.min(st.fails, 6));
  }
  async function once({ full = false } = {}) {
    if (!token) return { ok: false, error: 'SITE_EXPORT_TOKEN non défini' };
    if (current) return current; // jamais deux synchronisations en parallèle
    current = (async () => {
      const mode = full || startupFull || !st.cursor ? 'complète' : 'incrémentale';
      const url = new URL('/api/admin/anticheat-export', base); if (mode === 'incrémentale') url.searchParams.set('since', st.cursor);
      st.running = true; st.last_try = new Date(now()).toISOString(); let delay = interval;
      try {
        let r; try { r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'liveroums-anticheat' }, signal: AbortSignal.timeout(30000) }); }
        catch (e) { throw Object.assign(new Error('Réseau : ' + (e.cause?.code || e.message)), { kind: 'net' }); }
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Jeton refusé par le site (HTTP ${r.status}) : vérifier SITE_EXPORT_TOKEN = ANTICHEAT_EXPORT_TOKEN du site.`), { kind: 'auth' });
        if (r.status === 404) throw Object.assign(new Error('Export désactivé sur le site (HTTP 404) : définir ANTICHEAT_EXPORT_TOKEN côté site.'), { kind: 'auth' });
        if (r.status === 429) throw Object.assign(new Error('Limite de débit du site atteinte (HTTP 429).'), { kind: 'rate', retryAfter: +r.headers.get('retry-after') || null });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { kind: 'net' });
        let data; try { data = await r.json(); } catch { throw Object.assign(new Error('Réponse JSON invalide.'), { kind: 'net' }); }
        if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) throw Object.assign(new Error('Format d\'export inattendu.'), { kind: 'net' });
        const counts = importData(db, data, 'export');
        db.kvSet('last_export_sync', new Date(now()).toISOString());
        const gen = Date.parse(data.generated_at) || now();
        st.cursor = new Date(gen - OVERLAP).toISOString(); startupFull = false;
        Object.assign(st, { fails: 0, last_ok: new Date(now()).toISOString(), last_error: null, last_mode: mode, total_syncs: st.total_syncs + 1,
          last_counts: { joueurs: counts.joueurs, parties: counts.parties, comptes: counts.comptes, points: (data.points || []).length } });
        try { const a = await analyse(db); st.last_alerts = a.alerts; } catch (e) { log.warn?.('analyse : ' + e.message); }
        return { ok: true, mode, counts: st.last_counts, alerts: st.last_alerts };
      } catch (e) {
        delay = backoff(e.kind, e.retryAfter); st.last_error = { at: new Date(now()).toISOString(), message: String(e.message).slice(0, 300), kind: e.kind || 'net' };
        log.warn?.('[sync] ' + e.message);
        return { ok: false, error: st.last_error.message, kind: st.last_error.kind, delay };
      } finally { st.running = false; st.next_at = new Date(now() + delay).toISOString(); st.delay = delay; current = null; save(); }
    })();
    return current;
  }
  // Planification par setTimeout chaîné : le délai suivant dépend du résultat (backoff), aucune exception ne remonte
  function start(firstDelay = 3000) {
    if (!token || timer) return;
    const loop = async () => { try { await once(); } catch (e) { log.warn?.('[sync] ' + e.message); } timer = setTimeout(loop, st.delay || interval); timer.unref?.(); };
    timer = setTimeout(loop, firstDelay); timer.unref?.();
  }
  const stop = () => { clearTimeout(timer); timer = null; };
  // La sync est « saine » si un succès date de moins de 3 intervalles : la collecte publique peut alors rester en veille
  const healthy = () => !!(token && st.last_ok && now() - Date.parse(st.last_ok) < 3 * interval);
  const inBackoff = () => !!(st.fails && st.next_at && Date.parse(st.next_at) > now() && st.last_error?.kind === 'rate');
  save();
  return { once, start, stop, healthy, inBackoff, status: () => ({ ...st, interval_s: interval / 1000 }) };
}
module.exports = { createSync };

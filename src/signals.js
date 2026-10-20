// Inventaire des signaux : disponibles publiquement vs nécessitant une modification du site
const AVAILABLE = [
  ['/classement (HTML)', 'Top 100 classé Call of Duty : pseudo, SR, victoires / défaites, % victoires.', 'Smurf (taux de victoire, SR), z-scores'],
  ['/api/joueurs/:pseudo (JSON)', 'SR actuel, points LP, niveau, partie en cours (code), file classée / rapide.', "Découverte des codes de parties en cours, suivi du SR dans le temps"],
  ['/joueurs/:pseudo (HTML)', "Plateforme, date d'inscription (jour), comptes liés (Discord, Activision ID, PSN, Xbox, Battle.net, Steam ; vérifié ou non), V/D, tournois.", 'Multi-comptes (mêmes comptes liés / Discord, comptes créés le même jour), âge du compte pour les smurfs'],
  ['/api/parties/:code (JSON)', 'Statut, équipe gagnante, classé ou non, joueurs avec équipe, SR avant / après.', 'Win trading, farm, espérance Elo, boosting en quatuor, co-présence'],
  ['/parties/:code (HTML)', "Hôte (👑) et type exact (classée / rapide / privée).", "Hôte qui se déclare vainqueur contre les mêmes adversaires, parties privées"],
  ['/tournois/:id, /api/tournois', 'Brackets et vainqueurs des tournois.', '(non exploité dans la v1)'],
];
const UNAVAILABLE = [
  ['Historique complet des parties', "Les codes de partie ne sont visibles que pendant la partie (via /api/joueurs) : les parties courtes entre deux interrogations et tout l'historique antérieur au démarrage de l'agent sont invisibles."],
  ['Heures exactes', "Création de compte (seulement le jour), début/fin de partie (l'agent ne connaît que l'heure d'observation)."],
  ["Joueurs hors top 100 sans partie observée", 'Le classement public est limité à 100 joueurs ; les autres ne sont découverts que via les parties observées.'],
  ['Composition des quatuors', 'Déduite seulement (mêmes coéquipiers en classé) ; le code et les membres du quatuor ne sont pas publics.'],
  ['IP, empreinte d\'appareil, email', "Non collectés par le site (et non publics) : impossible de relier des comptes par l'adresse IP."],
  ['Historique des points LP (registre)', 'Seul le solde est public : farm de points visible uniquement via les parties observées.'],
  ['Discord ID technique', "Seul le nom affiché « Nom (@pseudo) » est public (suffisant pour une correspondance exacte, mais un renommage casse le lien)."],
  ['Données in-game', "Aucune (visée, temps de réaction…) : hors périmètre, aucune API Activision."],
];
const ENDPOINT = `GET /api/admin/anticheat-export?since=ISO8601   (lecture seule, en-tête Authorization: Bearer &lt;EXPORT_TOKEN&gt;, limité, paginé)
→ { users:   [{ pseudo, created_at, discord_id_hash, linked:[{provider, account_id_hash, verified}], last_login_ip_hash? }],
    lobbies: [{ code, kind, ranked, is_private, host, created_at, started_at, ended_at, winner_team,
                players:[{ pseudo, team, sr_before, sr_after, quatuor_id }] }],
    points:  [{ pseudo, amount, reason, created_at }] }   // identifiants sensibles hachés (HMAC) pour la confidentialité`;
const table = rows => `<table><tr><th>Source</th><th>Données</th><th>Détecteurs</th></tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const html = `<section><h1>📡 Signaux disponibles</h1><p class="muted">L'agent n'utilise que des pages et API <b>publiques</b> du site (sans connexion), en respectant la limite de 120 requêtes/min/IP (budget par défaut : 40/min).</p>
<h2>✅ Disponibles sans modifier le site</h2><div class="table-wrap">${table(AVAILABLE)}</div>
<h2>⛔ Indisponibles sans modification du site</h2><div class="table-wrap"><table><tr><th>Signal</th><th>Pourquoi</th></tr>${UNAVAILABLE.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table></div>
<h2>🔑 Endpoint d'export minimal qui les débloquerait (non construit)</h2><pre class="code-block">${ENDPOINT}</pre>
<p class="muted">En attendant : import manuel JSON/CSV (page Import).</p></section>`;
module.exports = { AVAILABLE, UNAVAILABLE, ENDPOINT, html };

// Démo locale : charge les données synthétiques et lance le tableau de bord (aucune collecte réseau)
// ADMIN_TOKEN=... node scripts/demo.js
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const { open } = require('../src/db'), S = require('../src/synthetic'), engine = require('../src/engine'), { createApp } = require('../src/server');
const db = open(':memory:'); S.load(db, S.build());
engine.run(db).then(() => {
  const { app } = createApp({ db, env: { ...process.env, DISCORD_WEBHOOK_URL: '', SMTP_URL: '', LLM_API_KEY: '' } });
  const port = process.env.PORT || 3501; app.listen(port, () => console.log(`Démo sur http://localhost:${port}`));
});

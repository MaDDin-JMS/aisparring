// Consistent snapshot of the live database (safe while the server runs), keeps the newest 10.
// Run inside the container: docker compose exec -T aichat node - < deploy/backup.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';

const dir = '/data/backups';
mkdirSync(dir, { recursive: true });
const file = `${dir}/aichat-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
new DatabaseSync('/data/aichat.db').exec(`VACUUM INTO '${file}'`);
const backups = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
for (const old of backups.slice(0, -10)) rmSync(`${dir}/${old}`);
console.log(`  Backup: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);

#!/usr/bin/env node
// Offline demo launcher. Run: node scripts/demo-mode.cjs [start|reset]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const profile = path.join(os.homedir(), '.config', 'flo-desktop-demo');
const demoDb = path.join(profile, 'flo-demo.db');
const liveCandidates = [
  path.join(root, 'flo.db'),
  path.join(os.homedir(), '.config', 'flo-desktop', 'flo.db'),
];
const mode = process.argv[2] || 'start';
if (!['start', 'reset'].includes(mode)) {
  console.error('Usage: node scripts/demo-mode.cjs [start|reset]');
  process.exit(2);
}
fs.mkdirSync(profile, { recursive: true });
if (mode === 'reset') {
  // Demo must be stopped before deleting its database.
  for (const suffix of ['', '-wal', '-shm']) {
    const file = demoDb + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('Demo transactions reset. Next start will copy the live menu again.');
  process.exit(0);
}
async function run() {
  if (!fs.existsSync(demoDb)) {
    const source = liveCandidates.find(p => fs.existsSync(p));
    if (!source) {
      console.error('No live flo.db found. Set up Flo normally first; demo was not started.');
      process.exitCode = 1;
      return;
    }
    // SQLite online backup creates a consistent snapshot without changing live data.
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(demoDb);
    } finally {
      db.close();
    }
    console.log('Created isolated demo snapshot. Live database untouched.');
  }
  const electron = require('electron');
  const child = spawn(electron, ['.'], {
    cwd: root,
    env: { ...process.env, FLO_DEMO_MODE: '1', FLO_DISABLE_CLOUD_SYNC: '1' },
    stdio: 'inherit',
  });
  child.on('exit', code => { process.exitCode = code || 0; });
}
run().catch(error => { console.error(error); process.exitCode = 1; });

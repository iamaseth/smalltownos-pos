/**
 * The BackStreet desktop build must not take FloCafe releases or register with FloAdmin.
 * Run: node tests/run-electron-node-test.cjs tests/backstreet-build.test.ts
 */
const fs = require('fs');
const path = require('path');
const { BACKSTREET_BUILD } = require('../shared/backstreet-build');

let passed = 0;
let failed = 0;
function check(ok: boolean, message: string) {
  if (ok) { passed++; console.log(`  ✓ ${message}`); } else { failed++; console.error(`  ✗ ${message}`); }
}

const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.ts'), 'utf8');
check(BACKSTREET_BUILD.upstreamAutoUpdate === false, 'FloCafe auto-update is off');
check(BACKSTREET_BUILD.upstreamCloud === false, 'FloAdmin cloud sync and telemetry are off');
check(/if \(BACKSTREET_BUILD\.upstreamCloud\) \{\s*cloudSync\.start\(\);\s*telemetry\.start\(\);/.test(source), 'cloud sync and telemetry start only when the switch is on');
check(/BACKSTREET_BUILD\.upstreamAutoUpdate\) \{\s*setupAutoUpdater\(\);/.test(source), 'the updater is set up only when the switch is on');
check(/function checkForUpdates\(\): void \{\s*if \(!BACKSTREET_BUILD\.upstreamAutoUpdate\)/.test(source), 'a manual update check does nothing when the switch is off');
check(Object.isFrozen(BACKSTREET_BUILD), 'the switches cannot be changed at run time');

console.log(`\nResults: ${passed}/${passed + failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

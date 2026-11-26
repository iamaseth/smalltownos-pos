/**
 * BackStreet: a wrong PIN on the register lock screen must not sign the device out.
 * The server answers a wrong PIN with 401 "Invalid PIN"; the app's 401 handler must
 * skip the PIN check, and the lock screen must say "Wrong PIN" instead of a generic error.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/wrong-pin-no-logout.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'frontend/src/lib/api.ts'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'frontend/src/hooks/useRegisterAccess.ts'), 'utf8');

const handler = api.slice(api.indexOf('api.interceptors.response.use'));
assert.ok(/endsWith\('\/register-access\/unlock'\)/.test(handler), 'the 401 handler recognises the PIN check');
assert.ok(/status === 401[^\n]*!isPinCheck/.test(handler), 'a 401 from the PIN check does not sign the device out');
assert.ok(handler.indexOf('isPinCheck') < handler.indexOf("localStorage.removeItem('token')"), 'the PIN check is skipped before the login is cleared');

assert.ok(hook.includes("'Wrong PIN. Try again.'"), 'the lock screen says Wrong PIN');
assert.ok(hook.includes('Too many wrong PINs'), 'the lock screen explains the 15-minute wait');
const wrongPin = hook.indexOf("'Wrong PIN. Try again.'");
const restore = hook.indexOf('await restoreAppUser();', hook.indexOf('} catch (err) {', hook.indexOf('const unlock = useCallback')));
assert.ok(wrongPin > 0 && wrongPin < restore, 'a wrong PIN returns before the app user is reset');

console.log('wrong-pin-no-logout: all checks passed');

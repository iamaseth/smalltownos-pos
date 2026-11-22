const assert = require('node:assert/strict');
const {
  REGISTER_SESSION_IDLE_TIMEOUT_MS,
  createRegisterSession,
  touchRegisterSession,
  revokeRegisterSession,
  resetRegisterSessionsForTests,
} = require('../main/services/register-session');

function run() {
  const originalNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    resetRegisterSessionsForTests();
    createRegisterSession('session-a', 'staff-a');
    assert.equal(touchRegisterSession('session-a', 'staff-a'), true, 'new session is active');
    assert.equal(touchRegisterSession('session-a', 'staff-b'), false, 'session cannot be used by another user');

    clock += REGISTER_SESSION_IDLE_TIMEOUT_MS - 1;
    assert.equal(touchRegisterSession('session-a', 'staff-a'), true, 'activity just before timeout renews session');

    clock += REGISTER_SESSION_IDLE_TIMEOUT_MS;
    assert.equal(touchRegisterSession('session-a', 'staff-a'), false, 'idle session expires server-side');

    createRegisterSession('session-b', 'staff-b');
    revokeRegisterSession('session-b', 'staff-b');
    assert.equal(touchRegisterSession('session-b', 'staff-b'), false, 'explicit lock revokes session');

    createRegisterSession('session-c', 'staff-c');
    revokeRegisterSession('session-c', 'someone-else');
    assert.equal(touchRegisterSession('session-c', 'staff-c'), true, 'another user cannot revoke this session');

    console.log('register-session: all checks passed');
  } finally {
    Date.now = originalNow;
    resetRegisterSessionsForTests();
  }
}

run();

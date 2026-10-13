const calls = new Map();
const STARTUP_GRACE_MS = 15_000;
const DISAPPEAR_GRACE_MS = 2_000;

function remember(callId, state) {
  calls.set(callId, { ...calls.get(callId), ...state, updatedAt: Date.now() });
  return calls.get(callId);
}

function get(callId) { return calls.get(callId) || null; }
function forget(callId) { calls.delete(callId); }

function shouldWaitForParticipant(callId, startedAt, now = Date.now()) {
  const state = get(callId);
  if (!state?.seenParticipant) return now - startedAt.getTime() < STARTUP_GRACE_MS;
  if (!state.missingSince) {
    remember(callId, { missingSince: now });
    return true;
  }
  return now - state.missingSince < DISAPPEAR_GRACE_MS;
}

module.exports = { remember, get, forget, shouldWaitForParticipant };

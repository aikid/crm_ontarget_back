const calls = new Map();

function remember(callId, state) {
  calls.set(callId, { ...calls.get(callId), ...state, updatedAt: Date.now() });
  return calls.get(callId);
}

function get(callId) { return calls.get(callId) || null; }
function forget(callId) { calls.delete(callId); }

module.exports = { remember, get, forget };

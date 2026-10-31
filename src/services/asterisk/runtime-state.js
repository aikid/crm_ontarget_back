const state = {
  enabled: false,
  configured: false,
  connected: false,
  connectedAt: null,
  disconnectedAt: null,
  lastEventAt: null,
  lastErrorAt: null,
  reconnectAttempts: 0,
};

function update(patch) {
  Object.assign(state, patch);
}

function snapshot() {
  return { ...state };
}

module.exports = { snapshot, update };

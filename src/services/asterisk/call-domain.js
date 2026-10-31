const { HttpError } = require("../../lib/http-error");

const TERMINAL_STATUSES = new Set([
  "ENDED",
  "FAILED",
  "CANCELED",
  "BUSY",
  "NO_ANSWER",
  "REJECTED",
]);

const TRANSITIONS = {
  READY: new Set(["DIALING", "CANCELED", "FAILED"]),
  DIALING: new Set(["RINGING", "CONNECTED", "RECONCILING", "CANCELED", "FAILED", "BUSY", "NO_ANSWER", "REJECTED"]),
  RINGING: new Set(["CONNECTED", "RECONCILING", "CANCELED", "FAILED", "BUSY", "NO_ANSWER", "REJECTED"]),
  CONNECTED: new Set(["RECONCILING", "ENDED", "FAILED"]),
  RECONCILING: new Set(["DIALING", "RINGING", "CONNECTED", "ENDED", "FAILED", "CANCELED", "BUSY", "NO_ANSWER", "REJECTED"]),
};

function normalizeBrazilianDestination(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) digits = `55${digits}`;
  if (!/^55[1-9]\d(?:\d{8}|\d{9})$/.test(digits)) {
    throw new HttpError(400, "Telefone deve conter DDD e número brasileiro válido.");
  }
  return digits;
}

function maskDestination(destination) {
  const value = String(destination || "");
  if (value.length < 6) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 6)}${value.slice(-4)}`;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function canTransition(from, to) {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  return Boolean(TRANSITIONS[from]?.has(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Transição de chamada inválida: ${from} -> ${to}.`);
  }
}

module.exports = {
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminalStatus,
  maskDestination,
  normalizeBrazilianDestination,
};

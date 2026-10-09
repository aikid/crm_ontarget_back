const http = require("node:http");
const https = require("node:https");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");

let cachedToken = null;
let tokenExpiresAt = 0;

function configured() {
  return Boolean(env.threeCx.pbxUrl && env.threeCx.clientId && env.threeCx.clientSecret && env.threeCx.appDn);
}

function assertConfigured() {
  const missing = Object.entries(env.threeCx)
    .filter(([key, value]) => ["pbxUrl", "clientId", "clientSecret", "appDn"].includes(key) && !value)
    .map(([key]) => key);
  if (missing.length) throw new HttpError(503, "Telefonia 3CX não configurada.", { missing });
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
  if (!/^\d{10,11}$/.test(digits)) {
    throw new HttpError(400, "Telefone deve conter apenas DDD e número, por exemplo 11947341276.");
  }
  return digits;
}

function pbxUrl(path) {
  return `${env.threeCx.pbxUrl.replace(/\/$/, "")}${path}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const reason = body?.reasontext || body?.reason || body?.error_description;
    const error = new Error(reason || `3CX respondeu HTTP ${response.status}.`);
    error.status = response.status;
    error.pbxBody = body;
    throw error;
  }
  return body;
}

async function getToken({ force = false } = {}) {
  assertConfigured();
  if (!force && cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.threeCx.clientId,
    client_secret: env.threeCx.clientSecret,
  });
  const response = await fetch(pbxUrl("/connect/token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await parseResponse(response);
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + Number(body.expires_in || 300) * 1_000;
  return cachedToken;
}

async function request(path, options = {}, retry = true) {
  const token = await getToken();
  const response = await fetch(pbxUrl(path), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(20_000),
  });
  if (response.status === 401 && retry) {
    await getToken({ force: true });
    return request(path, options, false);
  }
  return parseResponse(response);
}

async function makeCall(destination) {
  const body = await request(`/callcontrol/${encodeURIComponent(env.threeCx.appDn)}/makecall`, {
    method: "POST",
    body: JSON.stringify({ destination: normalizePhone(destination), timeout: 30 }),
    signal: AbortSignal.timeout(40_000),
  });
  if (body?.finalstatus && body.finalstatus !== "Success") {
    throw new Error(body.reasontext || body.reason || "A 3CX recusou a chamada.");
  }
  if (!body?.result?.callid) throw new Error("A 3CX não retornou o identificador da chamada.");
  return body.result;
}

async function getParticipants() {
  const body = await request(`/callcontrol/${encodeURIComponent(env.threeCx.appDn)}/participants`);
  return Array.isArray(body) ? body : [];
}

function participantForCall(participants, callId) {
  return participants.find((participant) => String(participant.callid) === String(callId)) || null;
}

async function dropParticipant(participantId) {
  return request(`/callcontrol/${encodeURIComponent(env.threeCx.appDn)}/participants/${encodeURIComponent(participantId)}/drop`, {
    method: "POST",
    body: JSON.stringify({ reason: "Encerrada pelo SDR no CRM OnTarget" }),
  });
}

function streamRequest(method, participantId, token, onResponse) {
  const url = new URL(pbxUrl(`/callcontrol/${encodeURIComponent(env.threeCx.appDn)}/participants/${encodeURIComponent(participantId)}/stream`));
  const transport = url.protocol === "http:" ? http : https;
  return transport.request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" } : {}),
    },
  }, onResponse);
}

async function openMediaBridge(participantId, { onAudio, onError, onEnded }) {
  const token = await getToken();
  let closed = false;
  const upload = streamRequest("POST", participantId, token, (response) => {
    if (![200, 204].includes(response.statusCode)) onError(new Error(`Envio de áudio recusado pela 3CX (HTTP ${response.statusCode}).`));
    response.resume();
  });
  upload.on("socket", (socket) => socket.setNoDelay(true));
  upload.on("error", (error) => { if (!closed) onError(error); });
  upload.flushHeaders();

  const download = streamRequest("GET", participantId, token, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      onError(new Error(`Recepção de áudio recusada pela 3CX (HTTP ${response.statusCode}).`));
      return;
    }
    response.on("data", onAudio);
    response.on("end", () => { if (!closed) onEnded(); });
    response.on("error", (error) => { if (!closed) onError(error); });
  });
  download.on("socket", (socket) => socket.setNoDelay(true));
  download.on("error", (error) => { if (!closed) onError(error); });
  download.end();

  return {
    write(chunk) { if (!closed && upload.writable) upload.write(chunk); },
    close() {
      if (closed) return;
      closed = true;
      upload.end();
      download.destroy();
    },
  };
}

module.exports = { configured, assertConfigured, normalizePhone, getToken, makeCall, getParticipants, participantForCall, dropParticipant, openMediaBridge };

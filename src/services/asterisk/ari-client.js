const WebSocket = require("ws");
const env = require("../../config/env");

class AriRequestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "AriRequestError";
    this.status = status;
    this.body = body;
  }
}

class AriClient {
  constructor(config = env.asterisk, dependencies = {}) {
    this.config = config;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.WebSocket = dependencies.WebSocket || WebSocket;
  }

  configured() {
    return Boolean(
      this.config.ariHttpUrl
      && this.config.ariWsUrl
      && this.config.ariApp
      && this.config.ariUser
      && this.config.ariPassword,
    );
  }

  assertConfigured() {
    if (!this.config.enabled) throw new Error("Integração Asterisk está desativada.");
    if (!this.config.ariUser || !this.config.ariPassword) {
      throw new Error("Credenciais ARI não configuradas no backend.");
    }
  }

  authorizationHeaders() {
    const token = Buffer.from(`${this.config.ariUser}:${this.config.ariPassword}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  async request(method, path, { query, body, timeoutMs = 10_000 } = {}) {
    this.assertConfigured();
    const url = new URL(`/ari${path.startsWith("/") ? path : `/${path}`}`, `${this.config.ariHttpUrl}/`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });

    const response = await this.fetch(url, {
      method,
      headers: {
        ...this.authorizationHeaders(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const detail = payload?.message || payload?.error || `ARI respondeu HTTP ${response.status}.`;
      throw new AriRequestError(detail, response.status, payload);
    }
    return payload;
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }

  post(path, query, body) {
    return this.request("POST", path, { query, body });
  }

  delete(path, query) {
    return this.request("DELETE", path, { query });
  }

  eventsUrl() {
    const url = new URL("/ari/events", `${this.config.ariWsUrl}/`);
    url.searchParams.set("app", this.config.ariApp);
    return url.toString();
  }

  openEvents() {
    this.assertConfigured();
    return new this.WebSocket(this.eventsUrl(), { headers: this.authorizationHeaders() });
  }
}

module.exports = { AriClient, AriRequestError };

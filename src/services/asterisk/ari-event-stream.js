const { AriClient } = require("./ari-client");
const runtime = require("./runtime-state");
const { persistCorrelatedAriEvent } = require("./ari-event-store");

class AriEventStream {
  constructor({
    client = new AriClient(),
    onEvent = persistCorrelatedAriEvent,
    onConnected = async () => {},
    onDisconnected = async () => {},
    logger = console,
  } = {}) {
    this.client = client;
    this.onEvent = onEvent;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.logger = logger;
    this.socket = null;
    this.timer = null;
    this.running = false;
    this.attempt = 0;
    this.queue = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    runtime.update({ enabled: this.client.config.enabled, configured: this.client.configured() });
    if (!this.client.config.enabled) return;
    if (!this.client.configured()) {
      runtime.update({ lastErrorAt: new Date().toISOString() });
      this.logger.warn("Asterisk habilitado, mas as credenciais ARI não estão configuradas.");
      return;
    }
    this.connect();
  }

  connect() {
    if (!this.running || this.socket) return;
    try {
      const socket = this.client.openEvents();
      this.socket = socket;
      socket.on("open", () => {
        this.attempt = 0;
        runtime.update({ connected: true, connectedAt: new Date().toISOString(), reconnectAttempts: 0 });
        this.logger.info("WebSocket ARI conectado.");
        this.queue = this.queue.then(() => this.onConnected()).catch((error) => {
          runtime.update({ lastErrorAt: new Date().toISOString() });
          this.logger.error("Falha ao reconciliar chamadas ARI:", error.message);
        });
      });
      socket.on("message", (data) => {
        let event;
        try { event = JSON.parse(data.toString()); }
        catch {
          this.logger.warn("Evento ARI inválido foi ignorado.");
          return;
        }
        runtime.update({ lastEventAt: new Date().toISOString() });
        this.queue = this.queue
          .then(() => this.onEvent(event))
          .catch((error) => {
            runtime.update({ lastErrorAt: new Date().toISOString() });
            this.logger.error("Falha ao persistir evento ARI:", error.message);
          });
      });
      socket.on("error", (error) => {
        runtime.update({ lastErrorAt: new Date().toISOString() });
        this.logger.error("WebSocket ARI apresentou erro:", error.message);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        runtime.update({ connected: false, disconnectedAt: new Date().toISOString() });
        if (this.running) {
          this.queue = this.queue.then(() => this.onDisconnected()).catch((error) => {
            runtime.update({ lastErrorAt: new Date().toISOString() });
            this.logger.error("Falha ao marcar chamadas para reconciliação:", error.message);
          });
        }
        this.scheduleReconnect();
      });
    } catch (error) {
      this.socket = null;
      runtime.update({ connected: false, lastErrorAt: new Date().toISOString() });
      this.logger.error("Não foi possível conectar ao WebSocket ARI:", error.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.running || this.timer) return;
    this.attempt += 1;
    const delay = Math.min(
      this.client.config.reconnectMaxMs,
      this.client.config.reconnectMinMs * (2 ** Math.min(this.attempt - 1, 8)),
    );
    runtime.update({ reconnectAttempts: this.attempt });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "Backend encerrando");
    await this.queue;
    runtime.update({ connected: false, disconnectedAt: new Date().toISOString() });
  }
}

module.exports = { AriEventStream };

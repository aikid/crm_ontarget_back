const crypto = require("node:crypto");
const env = require("../../config/env");
const prisma = require("../../lib/prisma");
const { AriClient, AriRequestError } = require("./ari-client");
const { persistCorrelatedAriEvent } = require("./ari-event-store");
const { isTerminalStatus } = require("./call-domain");
const { transitionCall } = require("./call-state");
const { accountForExtension } = require("./sip-accounts");

function failureFromCause(cause, causeText) {
  const label = String(causeText || "").toLowerCase();
  if (cause === 17 || label.includes("busy")) return "BUSY";
  if (cause === 19 || label.includes("no answer") || label.includes("user alerting")) return "NO_ANSWER";
  if (cause === 21 || label.includes("reject") || label.includes("forbidden")) return "REJECTED";
  return "FAILED";
}

class AsteriskCallEngine {
  constructor({
    database = prisma,
    client = new AriClient(),
    config = env.asterisk,
    logger = console,
    transition = transitionCall,
    persistEvent = persistCorrelatedAriEvent,
  } = {}) {
    this.database = database;
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.transition = transition;
    this.persistEvent = persistEvent;
    this.cleanupInProgress = new Set();
    this.sweepTimer = null;
  }

  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepExpired().catch((error) => this.logger.error("Falha na varredura de chamadas:", error.message));
    }, 1_000);
    this.sweepTimer.unref?.();
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async pendingIntent(event) {
    const args = event.args || [];
    if (args[0] !== this.config.webAppArg) return null;
    const channelName = event.channel?.name || "";
    const sourceExtension = channelName.match(/^PJSIP\/([^/-]+)-/)?.[1] || null;
    const account = accountForExtension(sourceExtension, this.config);
    if (!account && !channelName.startsWith(this.config.webChannelPrefix)) return null;
    const ownerFilter = account?.email ? { sdr: { is: { email: account.email } } } : {};
    const requestedAfter = new Date(Date.now() - this.config.intentTtlSeconds * 1_000);
    const explicitCallId = args[1];
    if (explicitCallId) {
      return this.database.call.findFirst({
        where: {
          id: explicitCallId,
          provider: "asterisk",
          status: "READY",
          requestedAt: { gte: requestedAfter },
          ...ownerFilter,
        },
      });
    }

    // Compatibilidade limitada com a POC atual. Nunca escolhe arbitrariamente entre SDRs.
    const pending = await this.database.call.findMany({
      where: { provider: "asterisk", status: "READY", requestedAt: { gte: requestedAfter }, ...ownerFilter },
      orderBy: { requestedAt: "asc" },
      take: 2,
    });
    return pending.length === 1 ? pending[0] : null;
  }

  async handleEvent(event) {
    try {
      if (event.type === "StasisStart" && event.args?.[0] === this.config.webAppArg) {
        await this.handleWebChannel(event);
      } else if (event.type === "StasisStart" && event.args?.[0] === "outbound") {
        await this.handleRemoteAnswered(event);
      } else if (event.type === "ChannelStateChange") {
        await this.handleChannelState(event);
      } else if (["StasisEnd", "ChannelDestroyed"].includes(event.type)) {
        await this.handleChannelEnded(event);
      } else if (event.type === "RecordingFinished") {
        await this.handleRecordingFinished(event);
      }
    } finally {
      await this.persistEvent(event, this.database);
    }
  }

  async handleWebChannel(event) {
    const channelId = event.channel?.id;
    if (!channelId) return;
    const call = await this.pendingIntent(event);
    if (!call) {
      this.logger.warn("Canal WebRTC rejeitado: nenhuma intenção única e válida.");
      await this.safeDelete(`/channels/${encodeURIComponent(channelId)}`);
      return;
    }

    const remoteChannelId = crypto.randomUUID();
    await this.database.call.update({
      where: { id: call.id },
      data: { ariWebChannelId: channelId, ariRemoteChannelId: remoteChannelId },
    });
    await this.transition(this.database, call.id, "DIALING", {
      rawType: event.type,
      reason: "Canal WebRTC validado; iniciando chamada pela OverTele.",
    });

    try {
      await this.client.post(`/channels/${encodeURIComponent(channelId)}/ring`);
      await this.client.post("/channels", {
        endpoint: `PJSIP/${call.destinationE164}@${this.config.trunkName}`,
        app: this.config.ariApp,
        appArgs: "outbound",
        channelId: remoteChannelId,
        timeout: Math.min(60, this.config.intentTtlSeconds),
      });
    } catch (error) {
      await this.cleanup(call.id, "FAILED", `Falha ARI na originação: ${error.message}`, { hangupInitiator: "system" });
    }
  }

  async handleRemoteAnswered(event) {
    const remoteChannelId = event.channel?.id;
    const call = await this.database.call.findFirst({
      where: { provider: "asterisk", ariRemoteChannelId: remoteChannelId, status: { in: ["DIALING", "RINGING", "RECONCILING"] } },
    });
    if (!call) {
      if (remoteChannelId) await this.safeDelete(`/channels/${encodeURIComponent(remoteChannelId)}`);
      return;
    }
    if (event.channel?.state !== "Up") {
      await this.cleanup(call.id, "FAILED", "Canal remoto entrou na aplicação sem estado Up.", { hangupInitiator: "system" });
      return;
    }

    const bridgeId = crypto.randomUUID();
    const recordingName = `call_${call.id}`;
    try {
      await this.client.post(`/channels/${encodeURIComponent(call.ariWebChannelId)}/answer`);
      await this.client.post("/bridges", { type: "mixing,proxy_media", bridgeId });
      await this.database.call.update({ where: { id: call.id }, data: { ariBridgeId: bridgeId } });
      await this.client.post(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
        channel: `${call.ariWebChannelId},${call.ariRemoteChannelId}`,
      });
      await this.database.callRecording.upsert({
        where: { callId: call.id },
        create: { callId: call.id, name: recordingName, status: "PENDING" },
        update: { name: recordingName, status: "PENDING", lastError: null },
      });
      await this.client.post(`/bridges/${encodeURIComponent(bridgeId)}/record`, {
        name: recordingName,
        format: "wav",
        ifExists: "fail",
        maxDurationSeconds: this.config.maxCallSeconds,
      });
      await this.database.callRecording.update({
        where: { callId: call.id },
        data: { status: "RECORDING", recordedAt: new Date(), lastError: null },
      });
      await this.transition(this.database, call.id, "CONNECTED", {
        rawType: event.type,
        reason: "Canal remoto atendido e bridge de áudio conectada.",
      });
    } catch (error) {
      await this.cleanup(call.id, "FAILED", `Falha ao configurar bridge/gravação: ${error.message}`, { hangupInitiator: "system" });
    }
  }

  async handleChannelState(event) {
    if (event.channel?.state !== "Ringing") return;
    const call = await this.database.call.findFirst({
      where: { provider: "asterisk", ariRemoteChannelId: event.channel.id, status: { in: ["DIALING", "RECONCILING"] } },
    });
    if (call) await this.transition(this.database, call.id, "RINGING", { rawType: event.type, reason: "Ringing reportado pelo Asterisk." });
  }

  async handleChannelEnded(event) {
    const channelId = event.channel?.id;
    if (!channelId) return;
    const call = await this.database.call.findFirst({
      where: {
        provider: "asterisk",
        OR: [{ ariWebChannelId: channelId }, { ariRemoteChannelId: channelId }],
        status: { in: ["DIALING", "RINGING", "CONNECTED", "RECONCILING"] },
      },
    });
    if (!call) return;
    const remoteEnded = channelId === call.ariRemoteChannelId;
    // StasisEnd normalmente é seguido por ChannelDestroyed, que traz a causa Q.850.
    // Aguardar esse segundo evento evita classificar a chamada sem a causa real.
    if (remoteEnded && event.type === "StasisEnd") return;
    const data = remoteEnded && event.type === "ChannelDestroyed"
      ? { q850Cause: Number.isInteger(event.cause) ? event.cause : null, disconnectReason: event.cause_txt || null }
      : {};
    const status = call.answeredAt ? "ENDED" : failureFromCause(event.cause, event.cause_txt);
    await this.cleanup(call.id, status, `Evento ${event.type}.`, { ...data, hangupInitiator: remoteEnded ? "remote" : "sdr" });
  }

  async handleRecordingFinished(event) {
    const name = event.recording?.name;
    if (!name) return;
    await this.database.callRecording.updateMany({
      where: { name }, data: { status: "STORED_LOCAL", lastError: null },
    });
  }

  async stopRecording(call) {
    if (!call.recording) return;
    const name = encodeURIComponent(call.recording.name);
    try {
      await this.client.post(`/recordings/live/${name}/stop`);
    } catch (error) {
      if (!(error instanceof AriRequestError) || error.status !== 404) {
        await this.database.callRecording.update({
          where: { callId: call.id }, data: { lastError: error.message },
        });
        return;
      }
      try {
        await this.client.get(`/recordings/stored/${name}`);
        await this.database.callRecording.update({
          where: { callId: call.id }, data: { status: "STORED_LOCAL", lastError: null },
        });
      } catch (storedError) {
        await this.database.callRecording.update({
          where: { callId: call.id }, data: { lastError: storedError.message },
        });
      }
    }
  }

  async cleanup(callId, status, reason, data = {}) {
    if (this.cleanupInProgress.has(callId)) return;
    this.cleanupInProgress.add(callId);
    try {
      const call = await this.database.call.findUnique({ where: { id: callId }, include: { recording: true } });
      if (!call) return;
      if (!isTerminalStatus(call.status)) await this.transition(this.database, call.id, status, { reason, data });
      await this.stopRecording(call);
      for (const channelId of [call.ariRemoteChannelId, call.ariWebChannelId]) {
        if (channelId) await this.safeDelete(`/channels/${encodeURIComponent(channelId)}`);
      }
      if (call.ariBridgeId) await this.safeDelete(`/bridges/${encodeURIComponent(call.ariBridgeId)}`);
    } finally {
      this.cleanupInProgress.delete(callId);
    }
  }

  async hangup(callId) {
    const current = await this.database.call.findUnique({ where: { id: callId } });
    if (!current) return null;
    const status = current.answeredAt || current.status === "CONNECTED" ? "ENDED" : "CANCELED";
    await this.cleanup(callId, status, "Encerramento solicitado pelo SDR.", { hangupInitiator: "sdr" });
    return this.database.call.findUnique({ where: { id: callId } });
  }

  async safeDelete(path) {
    try { await this.client.delete(path); }
    catch (error) {
      if (!(error instanceof AriRequestError) || error.status !== 404) this.logger.warn(`Falha ao remover recurso ARI: ${error.message}`);
    }
  }

  async sweepExpired(now = new Date()) {
    const readyBefore = new Date(now.getTime() - this.config.intentTtlSeconds * 1_000);
    const connectedBefore = new Date(now.getTime() - this.config.maxCallSeconds * 1_000);
    const calls = await this.database.call.findMany({
      where: {
        provider: "asterisk",
        OR: [
          { status: "READY", requestedAt: { lt: readyBefore } },
          { status: { in: ["DIALING", "RINGING"] }, dialingAt: { lt: readyBefore } },
          { status: "CONNECTED", answeredAt: { lt: connectedBefore } },
        ],
      },
      select: { id: true, status: true },
    });
    for (const call of calls) {
      const status = call.status === "READY" ? "CANCELED" : call.status === "CONNECTED" ? "ENDED" : "NO_ANSWER";
      await this.cleanup(call.id, status, "Tempo máximo da chamada atingido.", { hangupInitiator: "system" });
    }
  }

  async onDisconnected() {
    const active = await this.database.call.findMany({
      where: { provider: "asterisk", status: { in: ["DIALING", "RINGING", "CONNECTED"] } }, select: { id: true },
    });
    for (const call of active) {
      await this.transition(this.database, call.id, "RECONCILING", { reason: "Conexão ARI interrompida; aguardando reconciliação." });
    }
  }

  async reconcile() {
    const [channels, bridges] = await Promise.all([this.client.get("/channels"), this.client.get("/bridges")]);
    const channelIds = new Set((channels || []).map((channel) => channel.id));
    const bridgeIds = new Set((bridges || []).map((bridge) => bridge.id));
    const calls = await this.database.call.findMany({ where: { provider: "asterisk", status: "RECONCILING" } });
    for (const call of calls) {
      const hasChannel = channelIds.has(call.ariWebChannelId) || channelIds.has(call.ariRemoteChannelId);
      if (!hasChannel) {
        await this.cleanup(call.id, call.answeredAt ? "ENDED" : "FAILED", "Recursos ARI ausentes após reconciliação.", { hangupInitiator: "unknown" });
        continue;
      }
      const status = call.answeredAt && bridgeIds.has(call.ariBridgeId) ? "CONNECTED" : call.ringingAt ? "RINGING" : "DIALING";
      await this.transition(this.database, call.id, status, { reason: "Estado reconciliado com o Asterisk." });
    }
  }
}

module.exports = { AsteriskCallEngine, failureFromCause };

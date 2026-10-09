const { WebSocketServer, WebSocket } = require("ws");
const env = require("../config/env");
const prisma = require("../lib/prisma");
const { loadAuth } = require("../middleware/auth");
const threeCx = require("./three-cx");

const activeMedia = new Map();

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
  socket.destroy();
}

function attachTelephonyWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/api\/telephony\/calls\/([^/]+)\/media$/);
    if (!match) return reject(socket, "404 Not Found", "WebSocket não encontrado.");

    try {
      const origin = request.headers.origin;
      if (origin && !env.frontendUrls.includes(origin)) return reject(socket, "403 Forbidden", "Origem não permitida.");
      const auth = await loadAuth(request);
      if (!auth) return reject(socket, "401 Unauthorized", "Sessão inválida.");
      if (auth.user.role !== "SDR") return reject(socket, "403 Forbidden", "Perfil sem acesso à telefonia.");

      const callId = decodeURIComponent(match[1]);
      const call = await prisma.call.findFirst({ where: { id: callId, sdrId: auth.user.id, provider: "3cx", endedAt: null } });
      if (!call?.providerSid) return reject(socket, "404 Not Found", "Chamada ativa não encontrada.");
      if (activeMedia.has(callId)) return reject(socket, "409 Conflict", "A mídia desta chamada já está conectada.");

      const participant = threeCx.participantForCall(await threeCx.getParticipants(), call.providerSid);
      if (!participant || !["Connected", "Hold", "Held"].includes(participant.status)) {
        return reject(socket, "409 Conflict", "A chamada ainda não está conectada.");
      }

      wss.handleUpgrade(request, socket, head, (webSocket) => {
        activeMedia.set(callId, webSocket);
        wss.emit("connection", webSocket, { callId, participantId: participant.id });
      });
    } catch (error) {
      console.error("Falha ao abrir mídia 3CX:", error.message);
      reject(socket, "502 Bad Gateway", "Não foi possível abrir o áudio da chamada.");
    }
  });

  wss.on("connection", async (webSocket, context) => {
    const { callId, participantId } = context;
    let bridge = null;
    const sendControl = (payload) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(payload));
    };

    try {
      bridge = await threeCx.openMediaBridge(participantId, {
        onAudio(chunk) {
          if (webSocket.readyState === WebSocket.OPEN && webSocket.bufferedAmount < 512 * 1024) webSocket.send(chunk, { binary: true });
        },
        onError(error) {
          sendControl({ type: "error", message: error.message });
        },
        onEnded() {
          sendControl({ type: "ended" });
        },
      });
      sendControl({ type: "ready", sampleRate: 8000, channels: 1, encoding: "pcm_s16le" });
    } catch (error) {
      sendControl({ type: "error", message: error.message });
      webSocket.close(1011, "Falha ao iniciar mídia");
      return;
    }

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) bridge?.write(data);
    });
    webSocket.on("error", (error) => console.error("WebSocket de mídia 3CX:", error.message));
    webSocket.on("close", () => {
      bridge?.close();
      if (activeMedia.get(callId) === webSocket) activeMedia.delete(callId);
    });
  });

  return wss;
}

module.exports = { attachTelephonyWebSocket };

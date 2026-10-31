const app = require("./app");
const env = require("./config/env");
const prisma = require("./lib/prisma");
const { attachTelephonyWebSocket } = require("./services/telephony-websocket");
const { AriEventStream } = require("./services/asterisk/ari-event-stream");
const asteriskCallEngine = require("./services/asterisk/call-engine-instance");
const { Prisma } = require("@prisma/client");

if (!Prisma.CallScalarFieldEnum?.status) {
  throw new Error("Prisma Client desatualizado: execute `prisma generate` antes de iniciar a API.");
}

const server = app.listen(env.port, () => {
  console.log(`OnTarget API disponível em http://localhost:${env.port}`);
});
attachTelephonyWebSocket(server);
asteriskCallEngine.start();
const ariEventStream = new AriEventStream({
  onEvent: (event) => asteriskCallEngine.handleEvent(event),
  onConnected: () => asteriskCallEngine.reconcile(),
  onDisconnected: () => asteriskCallEngine.onDisconnected(),
});
ariEventStream.start();

async function shutdown(signal) {
  console.log(`${signal} recebido; encerrando API.`);
  await ariEventStream.stop();
  asteriskCallEngine.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

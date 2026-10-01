const app = require("./app");
const env = require("./config/env");
const prisma = require("./lib/prisma");

const server = app.listen(env.port, () => {
  console.log(`OnTarget API disponível em http://localhost:${env.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} recebido; encerrando API.`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

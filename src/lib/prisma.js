const { PrismaClient } = require("@prisma/client");

const prisma = globalThis.__onTargetPrisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__onTargetPrisma = prisma;
}

module.exports = prisma;


-- Etapa 1: autenticação, perfis e sessões persistidas.
CREATE TYPE "UserRole" AS ENUM ('GESTOR', 'SDR', 'CLIENT');

ALTER TABLE "User"
ADD COLUMN "passwordHash" TEXT NOT NULL DEFAULT '!',
ADD COLUMN "lastLoginAt" TIMESTAMP(3);

ALTER TABLE "User"
ALTER COLUMN "passwordHash" DROP DEFAULT,
ALTER COLUMN "role" TYPE "UserRole"
USING (
  CASE
    WHEN lower("role") IN ('gestor', 'manager', 'admin') THEN 'GESTOR'
    WHEN lower("role") IN ('client', 'client_manager', 'portal') THEN 'CLIENT'
    ELSE 'SDR'
  END
)::"UserRole";

CREATE TABLE "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

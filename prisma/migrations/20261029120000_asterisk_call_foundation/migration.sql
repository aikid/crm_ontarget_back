-- Fundação persistente da telefonia Asterisk/ARI.
-- A migração é aditiva para preservar o histórico legado da 3CX.
CREATE TYPE "CallStatus" AS ENUM (
  'READY',
  'DIALING',
  'RINGING',
  'CONNECTED',
  'RECONCILING',
  'ENDED',
  'FAILED',
  'CANCELED',
  'BUSY',
  'NO_ANSWER',
  'REJECTED'
);

CREATE TYPE "CallRecordingStatus" AS ENUM (
  'PENDING',
  'RECORDING',
  'UPLOADING',
  'STORED',
  'FAILED'
);

ALTER TABLE "Call"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "status" "CallStatus",
  ADD COLUMN "destinationE164" TEXT,
  ADD COLUMN "destinationMasked" TEXT,
  ADD COLUMN "disconnectReason" TEXT,
  ADD COLUMN "hangupInitiator" TEXT,
  ADD COLUMN "sipFinalCode" INTEGER,
  ADD COLUMN "q850Cause" INTEGER,
  ADD COLUMN "ariWebChannelId" TEXT,
  ADD COLUMN "ariRemoteChannelId" TEXT,
  ADD COLUMN "ariBridgeId" TEXT,
  ADD COLUMN "requestedAt" TIMESTAMP(3),
  ADD COLUMN "dialingAt" TIMESTAMP(3),
  ADD COLUMN "ringingAt" TIMESTAMP(3),
  ADD COLUMN "answeredAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Chamadas preexistentes pertencem ao histórico legado e não podem reaparecer
-- como intenções READY depois da introdução da máquina de estados.
UPDATE "Call"
SET
  "status" = CASE
    WHEN "result" = 'failed' THEN 'FAILED'::"CallStatus"
    ELSE 'ENDED'::"CallStatus"
  END,
  "requestedAt" = "startedAt",
  "updatedAt" = COALESCE("endedAt", "createdAt", CURRENT_TIMESTAMP);

ALTER TABLE "Call"
  ALTER COLUMN "provider" SET DEFAULT 'asterisk',
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'READY',
  ALTER COLUMN "requestedAt" SET NOT NULL,
  ALTER COLUMN "requestedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE TABLE "CallEvent" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "status" "CallStatus",
  "source" TEXT NOT NULL,
  "rawType" TEXT,
  "payload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallRecording" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "CallRecordingStatus" NOT NULL DEFAULT 'PENDING',
  "format" TEXT NOT NULL DEFAULT 'wav',
  "storageBucket" TEXT,
  "storageKey" TEXT,
  "sha256" TEXT,
  "sizeBytes" BIGINT,
  "recordedAt" TIMESTAMP(3),
  "uploadedAt" TIMESTAMP(3),
  "retentionDeleteAfter" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Call_sdrId_idempotencyKey_key" ON "Call"("sdrId", "idempotencyKey");
CREATE INDEX "Call_status_requestedAt_idx" ON "Call"("status", "requestedAt");
CREATE UNIQUE INDEX "Call_one_active_asterisk_per_sdr"
  ON "Call"("sdrId")
  WHERE "provider" = 'asterisk'
    AND "sdrId" IS NOT NULL
    AND "endedAt" IS NULL
    AND "status" IN ('READY', 'DIALING', 'RINGING', 'CONNECTED', 'RECONCILING');

CREATE UNIQUE INDEX "CallEvent_callId_seq_key" ON "CallEvent"("callId", "seq");
CREATE INDEX "CallEvent_callId_occurredAt_idx" ON "CallEvent"("callId", "occurredAt");

CREATE UNIQUE INDEX "CallRecording_callId_key" ON "CallRecording"("callId");
CREATE UNIQUE INDEX "CallRecording_name_key" ON "CallRecording"("name");
CREATE INDEX "CallRecording_status_createdAt_idx" ON "CallRecording"("status", "createdAt");

ALTER TABLE "CallEvent"
  ADD CONSTRAINT "CallEvent_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallRecording"
  ADD CONSTRAINT "CallRecording_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

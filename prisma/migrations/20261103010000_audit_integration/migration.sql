ALTER TABLE "Call" ADD COLUMN "attemptId" TEXT;

ALTER TABLE "Audit"
  ADD COLUMN "callId" TEXT,
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "recordingId" TEXT,
  ADD COLUMN "classification" TEXT,
  ADD COLUMN "observations" TEXT,
  ADD COLUMN "modelVersion" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Audit"
SET
  "classification" = CASE WHEN "status" <> 'not_audited' THEN "status" ELSE NULL END,
  "createdAt" = COALESCE("auditedAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE("auditedAt", CURRENT_TIMESTAMP);

DROP INDEX IF EXISTS "Audit_leadId_key";

CREATE UNIQUE INDEX "Call_attemptId_key" ON "Call"("attemptId");
CREATE UNIQUE INDEX "Audit_recordingId_key" ON "Audit"("recordingId");
CREATE INDEX "Audit_leadId_auditedAt_idx" ON "Audit"("leadId", "auditedAt");
CREATE INDEX "Audit_callId_idx" ON "Audit"("callId");
CREATE INDEX "Audit_attemptId_idx" ON "Audit"("attemptId");

ALTER TABLE "Call"
  ADD CONSTRAINT "Call_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Audit"
  ADD CONSTRAINT "Audit_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Audit_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Audit_recordingId_fkey"
  FOREIGN KEY ("recordingId") REFERENCES "CallRecording"("id") ON DELETE SET NULL ON UPDATE CASCADE;

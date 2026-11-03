ALTER TYPE "CallRecordingStatus" ADD VALUE IF NOT EXISTS 'DELETED';

ALTER TABLE "CallRecording"
  ADD COLUMN "localPath" TEXT,
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "CallRecording"
SET
  "localPath" = '/var/spool/asterisk/recording/' || "name" || '.' || "format",
  "verifiedAt" = CASE WHEN "status" = 'STORED_LOCAL' THEN "updatedAt" ELSE NULL END,
  "retentionDeleteAfter" = COALESCE("recordedAt", "createdAt") + INTERVAL '60 days'
WHERE "localPath" IS NULL OR "retentionDeleteAfter" IS NULL;

CREATE INDEX "CallRecording_retentionDeleteAfter_status_idx"
  ON "CallRecording"("retentionDeleteAfter", "status");

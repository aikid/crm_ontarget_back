-- A tentativa operacional passa a existir independentemente da chamada telefônica.
CREATE TYPE "LeadStatus" AS ENUM (
  'PENDING',
  'CALLBACK',
  'CONTACTED',
  'QUALIFIED',
  'NOT_QUALIFIED',
  'REFUSED',
  'EXHAUSTED',
  'INVALID_NUMBER'
);

CREATE TYPE "AttemptOutcome" AS ENUM (
  'NO_ANSWER',
  'INVALID_NUMBER',
  'REFUSED',
  'CONTACTED',
  'QUALIFIED',
  'NOT_QUALIFIED',
  'CALLBACK'
);

ALTER TABLE "Lead"
  ADD COLUMN "reservedById" TEXT,
  ADD COLUMN "reservedAt" TIMESTAMP(3),
  ADD COLUMN "reservedUntil" TIMESTAMP(3);

ALTER TABLE "Lead" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Lead"
  ALTER COLUMN "status" TYPE "LeadStatus"
  USING (
    CASE
      WHEN "status" = 'pending' THEN 'PENDING'
      WHEN "status" = 'callback' THEN 'CALLBACK'
      WHEN "status" = 'scheduled' THEN 'CONTACTED'
      WHEN "status" = 'qualified' THEN 'QUALIFIED'
      WHEN "status" = 'no_interest' THEN 'REFUSED'
      WHEN "status" = 'invalid' THEN 'INVALID_NUMBER'
      WHEN "status" = 'no_answer' AND "attempts" >= 3 THEN 'EXHAUSTED'
      WHEN "status" = 'no_answer' THEN 'PENDING'
      ELSE 'PENDING'
    END
  )::"LeadStatus";
ALTER TABLE "Lead" ALTER COLUMN "status" SET DEFAULT 'PENDING';

CREATE TABLE "Attempt" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "sdrId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "outcome" "AttemptOutcome" NOT NULL,
  "notes" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- Preserva o histórico já registrado no modelo antigo de chamadas.
INSERT INTO "Attempt" (
  "id", "leadId", "sdrId", "sequence", "outcome", "notes", "startedAt", "finishedAt", "createdAt"
)
SELECT
  'migrated-' || ranked."id",
  ranked."leadId",
  ranked."sdrId",
  ranked."sequence",
  (
    CASE
      WHEN ranked."result" = 'no_answer' THEN 'NO_ANSWER'
      WHEN ranked."result" = 'invalid' THEN 'INVALID_NUMBER'
      WHEN ranked."result" = 'no_interest' THEN 'REFUSED'
      WHEN ranked."result" = 'qualified' THEN 'QUALIFIED'
      WHEN ranked."result" = 'callback' THEN 'CALLBACK'
      ELSE 'CONTACTED'
    END
  )::"AttemptOutcome",
  ranked."detail",
  ranked."startedAt",
  COALESCE(ranked."endedAt", ranked."startedAt"),
  ranked."createdAt"
FROM (
  SELECT
    c.*,
    ROW_NUMBER() OVER (PARTITION BY c."leadId" ORDER BY c."startedAt", c."id")::INTEGER AS "sequence"
  FROM "Call" c
  WHERE c."sdrId" IS NOT NULL AND c."result" IS NOT NULL
) ranked;

UPDATE "Lead" lead
SET "attempts" = LEAST(3, GREATEST(lead."attempts", history."total"))
FROM (
  SELECT "leadId", COUNT(*)::INTEGER AS "total"
  FROM "Attempt"
  GROUP BY "leadId"
) history
WHERE lead."id" = history."leadId";

DROP INDEX IF EXISTS "Lead_campaignId_status_createdAt_idx";
CREATE INDEX "Lead_campaignId_status_reservedUntil_createdAt_idx"
  ON "Lead"("campaignId", "status", "reservedUntil", "createdAt");
CREATE INDEX "Lead_reservedById_reservedUntil_idx" ON "Lead"("reservedById", "reservedUntil");
CREATE UNIQUE INDEX "Attempt_leadId_sequence_key" ON "Attempt"("leadId", "sequence");
CREATE INDEX "Attempt_sdrId_createdAt_idx" ON "Attempt"("sdrId", "createdAt");
CREATE INDEX "Attempt_leadId_createdAt_idx" ON "Attempt"("leadId", "createdAt");

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_reservedById_fkey"
  FOREIGN KEY ("reservedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attempt"
  ADD CONSTRAINT "Attempt_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attempt"
  ADD CONSTRAINT "Attempt_sdrId_fkey"
  FOREIGN KEY ("sdrId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

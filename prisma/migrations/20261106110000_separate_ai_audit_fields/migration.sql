ALTER TABLE "Lead" ADD COLUMN "auditSummary" TEXT;
ALTER TABLE "Audit" ADD COLUMN "summary" TEXT;
ALTER TABLE "Audit" ALTER COLUMN "confidence" TYPE TEXT USING "confidence"::TEXT;

UPDATE "Audit"
SET "summary" = "observations"
WHERE "summary" IS NULL AND "observations" IS NOT NULL;

UPDATE "Lead" AS lead
SET "auditSummary" = latest."summary"
FROM (
  SELECT DISTINCT ON ("leadId") "leadId", "summary"
  FROM "Audit"
  WHERE "summary" IS NOT NULL
  ORDER BY "leadId", "auditedAt" DESC NULLS LAST, "createdAt" DESC
) AS latest
WHERE lead."id" = latest."leadId" AND lead."auditSummary" IS NULL;

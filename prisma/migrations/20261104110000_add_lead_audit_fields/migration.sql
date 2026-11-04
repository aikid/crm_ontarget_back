ALTER TABLE "Lead"
ADD COLUMN "audit" TEXT,
ADD COLUMN "auditNotes" TEXT,
ADD COLUMN "sellerOption" TEXT;

UPDATE "Lead" AS lead
SET
  "audit" = latest."classification",
  "auditNotes" = latest."observations"
FROM (
  SELECT DISTINCT ON ("leadId")
    "leadId",
    COALESCE("classification", "status") AS "classification",
    "observations"
  FROM "Audit"
  ORDER BY "leadId", "auditedAt" DESC NULLS LAST, "createdAt" DESC
) AS latest
WHERE lead."id" = latest."leadId";

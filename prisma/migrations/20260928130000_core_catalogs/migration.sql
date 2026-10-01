-- Etapa 2: hierarquia Cliente -> Loja -> Campanha -> Lead e desativação lógica.
CREATE TYPE "CampaignStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'COMPLETED');

ALTER TABLE "Client" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Store"
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Campaign" ADD COLUMN "storeId" TEXT;

UPDATE "Campaign" AS campaign
SET "storeId" = (
  SELECT store."id"
  FROM "Store" AS store
  WHERE store."clientId" = campaign."clientId"
  ORDER BY store."id"
  LIMIT 1
);

ALTER TABLE "Campaign" ALTER COLUMN "storeId" SET NOT NULL;

ALTER TABLE "Campaign"
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "status" TYPE "CampaignStatus"
USING upper("status")::"CampaignStatus",
ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- A V1 define uma única loja por campanha. Os leads existentes acompanham
-- a loja da campanha para que a hierarquia seja garantida também no banco.
UPDATE "Lead" AS lead
SET "storeId" = campaign."storeId"
FROM "Campaign" AS campaign
WHERE lead."campaignId" = campaign."id";

ALTER TABLE "Lead" DROP CONSTRAINT "Lead_campaignId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_storeId_fkey";

CREATE UNIQUE INDEX "Store_id_clientId_key" ON "Store"("id", "clientId");
CREATE INDEX "Campaign_storeId_idx" ON "Campaign"("storeId");
CREATE UNIQUE INDEX "Campaign_id_clientId_key" ON "Campaign"("id", "clientId");
CREATE UNIQUE INDEX "Campaign_id_storeId_clientId_key" ON "Campaign"("id", "storeId", "clientId");

ALTER TABLE "Campaign"
ADD CONSTRAINT "Campaign_storeId_clientId_fkey"
FOREIGN KEY ("storeId", "clientId") REFERENCES "Store"("id", "clientId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_campaignId_storeId_clientId_fkey"
FOREIGN KEY ("campaignId", "storeId", "clientId") REFERENCES "Campaign"("id", "storeId", "clientId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_storeId_clientId_fkey"
FOREIGN KEY ("storeId", "clientId") REFERENCES "Store"("id", "clientId")
ON DELETE RESTRICT ON UPDATE CASCADE;

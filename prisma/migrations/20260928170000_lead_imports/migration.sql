-- Etapa 3: lotes de importação, erros por linha e deduplicação por campanha.
CREATE TYPE "ImportStatus" AS ENUM ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "status" "ImportStatus" NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "importedRows" INTEGER NOT NULL,
  "rejectedRows" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportError" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "rawData" JSONB,
  CONSTRAINT "ImportError_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Lead"
ADD COLUMN "importBatchId" TEXT,
ADD COLUMN "importRow" INTEGER;

CREATE UNIQUE INDEX "Lead_campaignId_phone_key" ON "Lead"("campaignId", "phone");
CREATE INDEX "Lead_importBatchId_idx" ON "Lead"("importBatchId");
CREATE INDEX "ImportBatch_campaignId_createdAt_idx" ON "ImportBatch"("campaignId", "createdAt");
CREATE INDEX "ImportBatch_uploadedById_idx" ON "ImportBatch"("uploadedById");
CREATE INDEX "ImportError_batchId_rowNumber_idx" ON "ImportError"("batchId", "rowNumber");

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_importBatchId_fkey"
FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_campaignId_fkey"
FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedById_fkey"
FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportError" ADD CONSTRAINT "ImportError_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

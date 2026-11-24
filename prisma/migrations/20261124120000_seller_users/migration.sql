ALTER TYPE "UserRole" ADD VALUE 'SELLER';

ALTER TABLE "User"
ADD COLUMN "storeId" TEXT,
ADD COLUMN "sellerOption" TEXT,
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "User_storeId_clientId_idx" ON "User"("storeId", "clientId");

ALTER TABLE "User"
ADD CONSTRAINT "User_storeId_clientId_fkey"
FOREIGN KEY ("storeId", "clientId") REFERENCES "Store"("id", "clientId")
ON DELETE RESTRICT ON UPDATE CASCADE;

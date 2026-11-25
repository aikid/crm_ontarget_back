ALTER TABLE "Store" ADD COLUMN "email" TEXT;

UPDATE "Store" AS store
SET "email" = seller."email"
FROM "User" AS seller
WHERE seller."role" = 'SELLER'
  AND seller."storeId" = store."id";

INSERT INTO "Store" ("id", "clientId", "name", "email", "shortName", "active", "createdAt", "updatedAt")
SELECT
  'seller-' || seller."id",
  seller."clientId",
  seller."name",
  seller."email",
  COALESCE(seller."sellerOption", 'Todos'),
  seller."active",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User" AS seller
WHERE seller."role" = 'SELLER'
  AND seller."clientId" IS NOT NULL
  AND seller."storeId" IS NULL;

UPDATE "User"
SET "storeId" = 'seller-' || "id"
WHERE "role" = 'SELLER'
  AND "clientId" IS NOT NULL
  AND "storeId" IS NULL;

CREATE UNIQUE INDEX "Store_email_key" ON "Store"("email");

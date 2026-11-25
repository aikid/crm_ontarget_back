UPDATE "User"
SET "storeId" = NULL
WHERE "role" = 'SELLER'
  AND "storeId" LIKE 'seller-%';

DELETE FROM "Store"
WHERE "id" LIKE 'seller-%';

DROP INDEX IF EXISTS "Store_email_key";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "email";

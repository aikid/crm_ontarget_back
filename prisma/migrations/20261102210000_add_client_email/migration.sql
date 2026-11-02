ALTER TABLE "Client" ADD COLUMN "email" TEXT;

CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");

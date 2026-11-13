CREATE TABLE "SipAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "extension" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "isAssigned" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SipAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SipAccount_userId_key" ON "SipAccount"("userId");
CREATE UNIQUE INDEX "SipAccount_email_key" ON "SipAccount"("email");
CREATE UNIQUE INDEX "SipAccount_extension_key" ON "SipAccount"("extension");
CREATE INDEX "SipAccount_isAssigned_extension_idx" ON "SipAccount"("isAssigned", "extension");

ALTER TABLE "SipAccount"
ADD CONSTRAINT "SipAccount_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

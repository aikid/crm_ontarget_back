-- Eventos ARI podem ser reenviados após reconexão. A chave opcional permite
-- deduplicação por chamada sem afetar eventos comerciais já existentes.
ALTER TABLE "CallEvent" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "CallEvent_callId_dedupeKey_key" ON "CallEvent"("callId", "dedupeKey");

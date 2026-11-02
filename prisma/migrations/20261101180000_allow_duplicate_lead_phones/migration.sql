-- O telefone identifica o destino de contato, não a identidade do lead.
-- Leads distintos da mesma campanha podem compartilhar o mesmo telefone.
DROP INDEX IF EXISTS "Lead_campaignId_phone_key";
CREATE INDEX "Lead_campaignId_phone_idx" ON "Lead"("campaignId", "phone");

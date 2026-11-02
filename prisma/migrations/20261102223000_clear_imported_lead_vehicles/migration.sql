-- O veículo de interesse passa a ser coletado exclusivamente no feedback do SDR.
UPDATE "Lead" SET "vehicle" = NULL WHERE "vehicle" IS NOT NULL;

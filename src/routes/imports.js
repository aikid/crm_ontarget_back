const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { parseLeadFile, validateRows } = require("../services/lead-import");
const { getGoogleSheetsConfiguration, readGoogleSheet } = require("../services/google-sheets-import");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
const targetSchema = z.object({ clientId: z.string().min(1), storeId: z.string().min(1), campaignId: z.string().min(1) });
const googleSheetsSchema = targetSchema.extend({
  spreadsheetUrl: z.string().trim().min(1),
  sheetName: z.string().trim().max(100).optional(),
});

router.use(requireRole("GESTOR"));

router.get("/", async (request, response) => {
  const batches = await prisma.importBatch.findMany({
    where: request.query.campaignId ? { campaignId: String(request.query.campaignId) } : {},
    include: {
      client: { select: { id: true, name: true } },
      store: { select: { id: true, name: true, shortName: true } },
      campaign: { select: { id: true, name: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  response.json({ data: batches });
});

router.get("/google-sheets/config", (_request, response) => {
  response.json(getGoogleSheetsConfiguration());
});

router.get("/:id", async (request, response) => {
  const batch = await prisma.importBatch.findUnique({
    where: { id: request.params.id },
    include: {
      client: { select: { id: true, name: true } },
      store: { select: { id: true, name: true, shortName: true } },
      campaign: { select: { id: true, name: true } },
      uploadedBy: { select: { id: true, name: true } },
      errors: { orderBy: { rowNumber: "asc" }, take: 500 },
    },
  });
  if (!batch) throw new HttpError(404, "Lote de importação não encontrado.");
  response.json(batch);
});

async function findTargetCampaign(target) {
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: target.campaignId,
      clientId: target.clientId,
      storeId: target.storeId,
      status: "ACTIVE",
      client: { active: true },
      store: { active: true },
    },
  });
  if (!campaign) throw new HttpError(400, "A campanha deve estar ativa e pertencer ao cliente e à loja selecionados.");
  return campaign;
}

async function importRows({ campaign, parsed, fileName, uploadedById }) {
  const validated = validateRows(parsed.rows);
  const importable = validated.candidates;
  const errors = [...validated.errors];

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.importBatch.create({
      data: {
        clientId: campaign.clientId,
        storeId: campaign.storeId,
        campaignId: campaign.id,
        uploadedById,
        fileName: fileName.slice(0, 255),
        fileType: parsed.type,
        status: "COMPLETED",
        totalRows: parsed.rows.length,
        importedRows: 0,
        rejectedRows: errors.length,
      },
    });
    if (importable.length) {
      await tx.lead.createMany({
        data: importable.map((row) => ({
          clientId: campaign.clientId,
          storeId: campaign.storeId,
          campaignId: campaign.id,
          name: row.name,
          phone: row.phone,
          vehicle: row.vehicle,
          origin: row.origin,
          reason: row.reason,
          importBatchId: created.id,
          importRow: row.rowNumber,
        })),
      });
    }
    const inserted = await tx.lead.count({ where: { importBatchId: created.id } });
    if (errors.length) await tx.importError.createMany({ data: errors.map((error) => ({ ...error, batchId: created.id })) });
    if (inserted) await tx.campaign.update({ where: { id: campaign.id }, data: { receivedLeads: { increment: inserted } } });
    return tx.importBatch.update({
      where: { id: created.id },
      data: {
        importedRows: inserted,
        rejectedRows: errors.length,
        status: errors.length ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        completedAt: new Date(),
      },
      include: {
        client: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, shortName: true } },
        campaign: { select: { id: true, name: true } },
        uploadedBy: { select: { id: true, name: true } },
        errors: { orderBy: { rowNumber: "asc" }, take: 500 },
      },
    });
  });

  return batch;
}

router.post("/google-sheets", requireCsrf, async (request, response) => {
  const input = googleSheetsSchema.parse(request.body);
  const campaign = await findTargetCampaign(input);
  const parsed = await readGoogleSheet(input);
  const batch = await importRows({
    campaign,
    parsed,
    fileName: parsed.fileName,
    uploadedById: request.auth.user.id,
  });
  response.status(201).json(batch);
});

router.post("/", requireCsrf, upload.single("file"), async (request, response) => {
  if (!request.file) throw new HttpError(400, "Selecione um arquivo CSV ou XLSX.");
  const target = targetSchema.parse(request.body);
  const campaign = await findTargetCampaign(target);
  const parsed = await parseLeadFile(request.file);
  const batch = await importRows({
    campaign,
    parsed,
    fileName: request.file.originalname,
    uploadedById: request.auth.user.id,
  });

  response.status(201).json(batch);
});

module.exports = router;

const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/http-error");
const { requireCsrf, requireRole } = require("../middleware/auth");
const { parseLeadFile, validateRows } = require("../services/lead-import");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
const targetSchema = z.object({ clientId: z.string().min(1), storeId: z.string().min(1), campaignId: z.string().min(1) });

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

router.post("/", requireCsrf, upload.single("file"), async (request, response) => {
  if (!request.file) throw new HttpError(400, "Selecione um arquivo CSV ou XLSX.");
  const target = targetSchema.parse(request.body);
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

  const parsed = await parseLeadFile(request.file);
  const validated = validateRows(parsed.rows);
  const phones = validated.candidates.map((row) => row.phone);
  const existing = phones.length ? await prisma.lead.findMany({
    where: { campaignId: campaign.id, phone: { in: phones } },
    select: { phone: true },
  }) : [];
  const existingPhones = new Set(existing.map((lead) => lead.phone));
  const importable = [];
  const errors = [...validated.errors];
  for (const row of validated.candidates) {
    if (existingPhones.has(row.phone)) errors.push({ rowNumber: row.rowNumber, code: "DUPLICATE_IN_CAMPAIGN", message: "Já existe um lead com este telefone na campanha.", rawData: row.rawData });
    else importable.push(row);
  }

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.importBatch.create({
      data: {
        clientId: campaign.clientId,
        storeId: campaign.storeId,
        campaignId: campaign.id,
        uploadedById: request.auth.user.id,
        fileName: request.file.originalname.slice(0, 255),
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
        skipDuplicates: true,
      });
    }
    const inserted = await tx.lead.findMany({ where: { importBatchId: created.id }, select: { phone: true } });
    const insertedPhones = new Set(inserted.map((lead) => lead.phone));
    for (const row of importable) {
      if (!insertedPhones.has(row.phone)) errors.push({ rowNumber: row.rowNumber, code: "DUPLICATE_IN_CAMPAIGN", message: "O telefone foi importado simultaneamente por outro lote.", rawData: row.rawData });
    }
    if (errors.length) await tx.importError.createMany({ data: errors.map((error) => ({ ...error, batchId: created.id })) });
    if (inserted.length) await tx.campaign.update({ where: { id: campaign.id }, data: { receivedLeads: { increment: inserted.length } } });
    return tx.importBatch.update({
      where: { id: created.id },
      data: {
        importedRows: inserted.length,
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

  response.status(201).json(batch);
});

module.exports = router;

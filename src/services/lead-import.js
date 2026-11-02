const path = require("node:path");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const { HttpError } = require("../lib/http-error");

const FIELD_ALIASES = {
  acao: ["acao"],
  telefone: ["numero", "telefone"],
  nome: ["nome_cliente", "nome"],
  dataAcao: ["dia_da_acao"],
  veiculo: ["veiculo", "veiculo_interesse", "carro"],
  origem: ["origem", "origem_base"],
  motivo: ["motivo", "origem_base_motivo"],
};
const OFFICIAL_REQUIRED_HEADERS = ["acao", "telefone", "nome", "origem", "dataAcao"];
const LEGACY_REQUIRED_HEADERS = ["nome", "telefone", "veiculo", "origem"];
const MAX_ROWS = 10_000;

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const day = String(value.getUTCDate()).padStart(2, "0");
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${day}/${month}/${value.getUTCFullYear()}`;
  }
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
  }
  return String(value).trim();
}

function assertHeaders(headers) {
  const hasHeaders = (fields) => fields.every((field) => FIELD_ALIASES[field].some((header) => headers.includes(header)));
  if (hasHeaders(OFFICIAL_REQUIRED_HEADERS)) return "OFFICIAL";
  if (hasHeaders(LEGACY_REQUIRED_HEADERS)) return "LEGACY";
  throw new HttpError(400, "O arquivo deve conter as colunas: Ação, Numero, Nome Cliente, ORIGEM e DIA DA AÇÃO.");
}

function canonicalizeRowData(data) {
  return Object.fromEntries(Object.entries(FIELD_ALIASES).map(([field, aliases]) => {
    const value = aliases.map((alias) => data[alias]).find((candidate) => String(candidate || "").trim());
    return [field, value || ""];
  }));
}

function rowsFromMatrix(matrix) {
  if (!matrix.length) throw new HttpError(400, "O arquivo está vazio.");
  const headers = matrix[0].map(normalizeHeader);
  const format = assertHeaders(headers);
  const rows = matrix.slice(1)
    .map((values, index) => {
      const sourceData = Object.fromEntries(headers.map((header, column) => [header, cellText(values[column])]));
      return { rowNumber: index + 2, sourceData, data: canonicalizeRowData(sourceData), format };
    })
    .filter((row) => Object.values(row.sourceData).some(Boolean))
    .map(({ rowNumber, data, format: rowFormat }) => ({ rowNumber, data, format: rowFormat }));
  if (!rows.length) throw new HttpError(400, "O arquivo não possui linhas de leads.");
  if (rows.length > MAX_ROWS) throw new HttpError(400, `O arquivo excede o limite de ${MAX_ROWS} leads por importação.`);
  return rows;
}

function detectDelimiter(text) {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

function parseCsv(buffer) {
  const text = buffer.toString("utf8");
  let matrix;
  try {
    matrix = parse(text, {
      bom: true,
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    throw new HttpError(400, "Não foi possível interpretar o arquivo CSV.", { reason: error.message });
  }
  return rowsFromMatrix(matrix);
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw new HttpError(400, "Não foi possível interpretar o arquivo XLSX.", { reason: error.message });
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new HttpError(400, "A planilha não possui abas.");
  const matrix = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    matrix.push(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).value));
  });
  return rowsFromMatrix(matrix);
}

async function parseLeadFile(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".csv") return { type: "CSV", rows: parseCsv(file.buffer) };
  if (extension === ".xlsx") return { type: "XLSX", rows: await parseXlsx(file.buffer) };
  throw new HttpError(400, "Formato não suportado. Envie um arquivo CSV ou XLSX.");
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  let normalized;
  if (raw.startsWith("+") && /^\+[1-9]\d{7,14}$/.test(`+${digits}`)) normalized = `+${digits}`;
  else if (/^\d{10,11}$/.test(digits)) normalized = `+55${digits}`;
  else if (/^55\d{10,11}$/.test(digits)) normalized = `+${digits}`;
  if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Telefone inválido. Use DDD + número, por exemplo (61) 99999-8877.");
  }
  return normalized;
}

function parseActionDate(value) {
  const match = String(value || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error("Dia da ação inválido. Use o formato dd/mm/aaaa.");
  const [, day, month, year] = match;
  const parsed = new Date(`${year}-${month}-${day}T12:00:00-03:00`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
  ) throw new Error("Dia da ação inválido. Use uma data existente no formato dd/mm/aaaa.");
  return parsed;
}

function validateRows(rows) {
  const candidates = [];
  const errors = [];

  for (const row of rows) {
    const rawData = {
      acao: row.data.acao || "",
      nome: row.data.nome || "",
      telefone: row.data.telefone || "",
      dataAcao: row.data.dataAcao || "",
      veiculo: row.data.veiculo || "",
      origem: row.data.origem || "",
      motivo: row.data.motivo || "",
    };
    try {
      if (rawData.nome.length < 2) throw new Error("Nome deve ter ao menos 2 caracteres.");
      const official = row.format === "OFFICIAL";
      if (official && !rawData.acao) throw new Error("Ação é obrigatória.");
      if (!official && !rawData.veiculo) throw new Error("Veículo é obrigatório no modelo anterior.");
      if (!official && !rawData.origem) throw new Error("Origem é obrigatória no modelo anterior.");
      if (rawData.nome.length > 120 || rawData.acao.length > 160 || rawData.veiculo.length > 120 || rawData.origem.length > 120 || rawData.motivo.length > 500) {
        throw new Error("Uma ou mais informações excedem o tamanho permitido.");
      }
      const phone = normalizePhone(rawData.telefone);
      const actionDate = official ? parseActionDate(rawData.dataAcao) : null;
      candidates.push({
        rowNumber: row.rowNumber,
        phone,
        name: rawData.nome,
        action: rawData.acao || null,
        actionDate,
        vehicle: rawData.veiculo || null,
        origin: rawData.origem,
        reason: rawData.motivo || null,
        rawData,
      });
    } catch (error) {
      errors.push({ rowNumber: row.rowNumber, code: "INVALID_ROW", message: error.message, rawData });
    }
  }
  return { candidates, errors };
}

module.exports = { FIELD_ALIASES, MAX_ROWS, normalizeHeader, normalizePhone, parseActionDate, parseLeadFile, parseCsv, parseXlsx, rowsFromMatrix, validateRows };

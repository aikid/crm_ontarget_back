const path = require("node:path");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const { HttpError } = require("../lib/http-error");

const REQUIRED_HEADERS = ["nome", "telefone", "veiculo", "origem"];
const MAX_ROWS = 10_000;

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
  }
  return String(value).trim();
}

function assertHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new HttpError(400, `O arquivo não contém as colunas obrigatórias: ${missing.join(", ")}.`);
  }
}

function rowsFromMatrix(matrix) {
  if (!matrix.length) throw new HttpError(400, "O arquivo está vazio.");
  const headers = matrix[0].map(normalizeHeader);
  assertHeaders(headers);
  const rows = matrix.slice(1)
    .map((values, index) => {
      const data = Object.fromEntries(headers.map((header, column) => [header, cellText(values[column])]));
      return { rowNumber: index + 2, data };
    })
    .filter((row) => Object.values(row.data).some(Boolean));
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

function validateRows(rows) {
  const candidates = [];
  const errors = [];
  const seenPhones = new Set();

  for (const row of rows) {
    const rawData = {
      nome: row.data.nome || "",
      telefone: row.data.telefone || "",
      veiculo: row.data.veiculo || "",
      origem: row.data.origem || "",
      motivo: row.data.motivo || "",
    };
    try {
      if (rawData.nome.length < 2) throw new Error("Nome deve ter ao menos 2 caracteres.");
      if (!rawData.veiculo) throw new Error("Veículo é obrigatório.");
      if (!rawData.origem) throw new Error("Origem é obrigatória.");
      if (rawData.nome.length > 120 || rawData.veiculo.length > 120 || rawData.origem.length > 120 || rawData.motivo.length > 500) {
        throw new Error("Uma ou mais informações excedem o tamanho permitido.");
      }
      const phone = normalizePhone(rawData.telefone);
      if (seenPhones.has(phone)) {
        errors.push({ rowNumber: row.rowNumber, code: "DUPLICATE_IN_FILE", message: "Telefone repetido neste arquivo.", rawData });
        continue;
      }
      seenPhones.add(phone);
      candidates.push({ rowNumber: row.rowNumber, phone, name: rawData.nome, vehicle: rawData.veiculo, origin: rawData.origem, reason: rawData.motivo || null, rawData });
    } catch (error) {
      errors.push({ rowNumber: row.rowNumber, code: "INVALID_ROW", message: error.message, rawData });
    }
  }
  return { candidates, errors };
}

module.exports = { MAX_ROWS, normalizeHeader, normalizePhone, parseLeadFile, parseCsv, parseXlsx, validateRows };

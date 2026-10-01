const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { normalizePhone, parseCsv, parseXlsx, validateRows } = require("../src/services/lead-import");

test("normaliza telefones brasileiros para E.164", () => {
  assert.equal(normalizePhone("(61) 99999-8877"), "+5561999998877");
  assert.equal(normalizePhone("55 61 98888-7766"), "+5561988887766");
  assert.throws(() => normalizePhone("123"), /Telefone inválido/);
});

test("interpreta CSV com cabeçalhos fixos e registra duplicidade interna", () => {
  const rows = parseCsv(Buffer.from([
    "nome;telefone;veículo;origem;motivo",
    "Maria Silva;(61) 99999-0001;Nivus;Site;Campanha",
    "Maria Duplicada;+5561999990001;Polo;Meta;",
  ].join("\n")));
  const result = validateRows(rows);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "DUPLICATE_IN_FILE");
});

test("interpreta a primeira aba de arquivo XLSX", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.addRow(["nome", "telefone", "veículo", "origem", "motivo"]);
  sheet.addRow(["Carlos Teste", "61988887766", "T-Cross", "Evento", "Feirão"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const rows = await parseXlsx(Buffer.from(buffer));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.nome, "Carlos Teste");
  assert.equal(rows[0].data.veiculo, "T-Cross");
});

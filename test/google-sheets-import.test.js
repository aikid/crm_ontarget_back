const test = require("node:test");
const assert = require("node:assert/strict");
const { parseServiceAccount, parseSpreadsheetReference } = require("../src/services/google-sheets-import");
const { rowsFromMatrix, validateRows } = require("../src/services/lead-import");

test("extrai planilha e aba de um link do Google Sheets", () => {
  const parsed = parseSpreadsheetReference("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=123456");
  assert.equal(parsed.spreadsheetId, "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  assert.equal(parsed.gid, 123456);
  assert.throws(() => parseSpreadsheetReference("https://example.com/planilha"), /docs.google.com/);
});

test("interpreta a credencial JSON da conta de serviço sem expor a chave", () => {
  const credentials = parseServiceAccount(JSON.stringify({
    client_email: "importador@projeto.iam.gserviceaccount.com",
    private_key: "linha-1\\nlinha-2",
  }));
  assert.equal(credentials.client_email, "importador@projeto.iam.gserviceaccount.com");
  assert.equal(credentials.private_key, "linha-1\nlinha-2");
  assert.throws(() => parseServiceAccount("{}"), /credencial.*inválida/i);
});

test("Google Sheets reaproveita as mesmas colunas e validações dos arquivos", () => {
  const rows = rowsFromMatrix([
    ["nome", "telefone", "veículo", "origem", "motivo"],
    ["Lead Sheets", "11947341276", "Nivus", "Google Sheets", "Campanha"],
    ["Inválido", "123", "Polo", "Google Sheets", ""],
  ]);
  const result = validateRows(rows);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].phone, "+5511947341276");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].rowNumber, 3);
});

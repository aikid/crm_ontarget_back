const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { normalizePhone, parseActionDate, parseCsv, parseXlsx, validateRows } = require("../src/services/lead-import");

test("normaliza telefones brasileiros para E.164", () => {
  assert.equal(normalizePhone("(61) 99999-8877"), "+5561999998877");
  assert.equal(normalizePhone("55 61 98888-7766"), "+5561988887766");
  assert.throws(() => normalizePhone("123"), /Telefone inválido/);
});

test("valida dia da ação no formato brasileiro", () => {
  assert.equal(parseActionDate("10/11/2026").toISOString(), "2026-11-10T15:00:00.000Z");
  assert.throws(() => parseActionDate("2026-11-10"), /dd\/mm\/aaaa/);
  assert.throws(() => parseActionDate("31/02/2026"), /data existente/);
});

test("interpreta o modelo oficial com origem opcional", () => {
  const rows = parseCsv(Buffer.from([
    "Ação;Numero;Nome Cliente;ORIGEM;DIA DA AÇÃO",
    "Feirão / Loja Centro;11947341276;Maria Silva;;10/11/2026",
    "Evento SUV;11982696480;João Pereira;Indicação;12/11/2026",
  ].join("\n")));
  const result = validateRows(rows);
  assert.equal(result.errors.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].action, "Feirão / Loja Centro");
  assert.equal(result.candidates[0].origin, "");
  assert.equal(result.candidates[0].vehicle, null);
  assert.equal(result.candidates[0].actionDate.toISOString(), "2026-11-10T15:00:00.000Z");
});

test("rejeita somente linhas inválidas do modelo oficial", () => {
  const rows = parseCsv(Buffer.from([
    "Ação;Numero;Nome Cliente;ORIGEM;DIA DA AÇÃO",
    "Evento válido;11947341276;Maria Silva;;10/11/2026",
    ";123;X;;31/02/2026",
  ].join("\n")));
  const result = validateRows(rows);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].rowNumber, 3);
});

test("interpreta CSV com cabeçalhos fixos e aceita telefones repetidos", () => {
  const rows = parseCsv(Buffer.from([
    "nome;telefone;veículo;origem;motivo",
    "Maria Silva;(61) 99999-0001;Nivus;Site;Campanha",
    "Maria Duplicada;+5561999990001;Polo;Meta;",
  ].join("\n")));
  const result = validateRows(rows);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.candidates[0].phone, result.candidates[1].phone);
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

test("aceita o modelo amplo da OnTarget e aplica os fallbacks definidos", () => {
  const rows = parseCsv(Buffer.from([
    "AÇÃO,ORIGEM BASE,LOJA,NOME,TELEFONE,CARRO,ORIGEM/BASE/MOTIVO,VEÍCULO INTERESSE,STATUS FLUXO",
    "Liquid Nasa,Meta Ads,SIA,Diego Mendes,11982568929,Polo,Campanha de novembro,Nivus,DISPARO ENVIADO",
    "Liquid Nasa,Site,SIA,Ana Souza,11947341276,T-Cross,Feirão,,NOVO",
  ].join("\n")));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].data, {
    acao: "Liquid Nasa",
    nome: "Diego Mendes",
    telefone: "11982568929",
    dataAcao: "",
    veiculo: "Nivus",
    origem: "Meta Ads",
    motivo: "Campanha de novembro",
  });
  assert.equal(rows[1].data.veiculo, "T-Cross");
  const validated = validateRows(rows);
  assert.equal(validated.candidates.length, 2);
  assert.equal(validated.candidates[0].vehicle, null);
  assert.equal(validated.candidates[1].vehicle, null);
});

const { google } = require("googleapis");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");
const { rowsFromMatrix } = require("./lead-import");

const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SPREADSHEET_ID_PATTERN = /^[a-zA-Z0-9_-]{20,}$/;

function parseServiceAccount(value = env.googleSheets.serviceAccountJson) {
  if (!value) throw new HttpError(503, "A importação por Google Sheets ainda não foi configurada no servidor.");
  try {
    const credentials = JSON.parse(value);
    if (!credentials.client_email || !credentials.private_key) throw new Error("client_email ou private_key ausente");
    return {
      ...credentials,
      private_key: credentials.private_key.replace(/\\n/g, "\n"),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "A credencial da conta de serviço do Google Sheets é inválida.");
  }
}

function getGoogleSheetsConfiguration() {
  if (!env.googleSheets.serviceAccountJson) return { configured: false, serviceAccountEmail: null };
  try {
    const credentials = parseServiceAccount();
    return { configured: true, serviceAccountEmail: credentials.client_email };
  } catch (error) {
    return { configured: false, serviceAccountEmail: null, error: error.message };
  }
}

function parseSpreadsheetReference(reference) {
  const value = String(reference || "").trim();
  if (!value) throw new HttpError(400, "Informe o link da planilha do Google Sheets.");
  if (SPREADSHEET_ID_PATTERN.test(value)) return { spreadsheetId: value, gid: null };

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "O link informado não é uma planilha válida do Google Sheets.");
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new HttpError(400, "Use um link válido de docs.google.com/spreadsheets.");
  }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new HttpError(400, "O link informado não contém o identificador da planilha.");
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const gidValue = hashParams.get("gid") || url.searchParams.get("gid");
  return { spreadsheetId: match[1], gid: /^\d+$/.test(gidValue || "") ? Number(gidValue) : null };
}

function a1SheetName(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function googleHttpError(error, serviceAccountEmail) {
  const status = Number(error?.response?.status || error?.code);
  if (status === 403) {
    return new HttpError(403, `A conta de serviço não conseguiu acessar a planilha. Confirme que a Google Sheets API está ativa e compartilhe a planilha como Leitora com ${serviceAccountEmail}.`);
  }
  if (status === 404) return new HttpError(404, "A planilha não foi encontrada ou o link está incorreto.");
  if (status === 400) return new HttpError(400, "Não foi possível ler a aba informada na planilha.");
  return new HttpError(502, "O Google Sheets não respondeu como esperado. Tente novamente em instantes.");
}

async function readGoogleSheet({ spreadsheetUrl, sheetName }) {
  const credentials = parseServiceAccount();
  const { spreadsheetId, gid } = parseSpreadsheetReference(spreadsheetUrl);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [READONLY_SCOPE] });
  const sheets = google.sheets({ version: "v4", auth });

  try {
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(sheetId,title,hidden,index)",
    });
    const availableSheets = (metadata.data.sheets || []).map((sheet) => sheet.properties).filter(Boolean);
    const requestedName = String(sheetName || "").trim();
    const selected = requestedName
      ? availableSheets.find((sheet) => sheet.title === requestedName)
      : gid !== null
        ? availableSheets.find((sheet) => sheet.sheetId === gid)
        : availableSheets.find((sheet) => !sheet.hidden) || availableSheets[0];

    if (!selected) {
      throw new HttpError(400, requestedName
        ? `A aba "${requestedName}" não existe nessa planilha.`
        : "A planilha não possui uma aba disponível para importação.");
    }

    const values = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${a1SheetName(selected.title)}!A1:Z10002`,
      majorDimension: "ROWS",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = rowsFromMatrix(values.data.values || []);
    const documentTitle = metadata.data.properties?.title || "Google Sheets";
    return {
      type: "GOOGLE_SHEETS",
      rows,
      fileName: `${documentTitle} · ${selected.title}`.slice(0, 255),
      spreadsheetId,
      sheetName: selected.title,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw googleHttpError(error, credentials.client_email);
  }
}

module.exports = {
  getGoogleSheetsConfiguration,
  parseServiceAccount,
  parseSpreadsheetReference,
  readGoogleSheet,
};

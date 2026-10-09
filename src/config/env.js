const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL não configurada. Adicione a URL de conexão PostgreSQL ao arquivo backend/.env.",
  );
}

function list(value, fallback = []) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

module.exports = {
  port: Number(process.env.PORT || 3333),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  frontendUrls: list(process.env.FRONTEND_URL, ["http://localhost:3000", "http://localhost:5173"]),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  session: {
    cookieName: process.env.SESSION_COOKIE_NAME || "ontarget.sid",
    ttlHours: Number(process.env.SESSION_TTL_HOURS || 12),
    sameSite: process.env.SESSION_COOKIE_SAME_SITE || "lax",
    secure: process.env.SESSION_COOKIE_SECURE
      ? process.env.SESSION_COOKIE_SECURE === "true"
      : (process.env.NODE_ENV || "development") === "production",
  },
  threeCx: {
    pbxUrl: process.env.CX3_PBX_URL || "https://8rtech.my3cx.com.br",
    clientId: process.env.CX3_CLIENT_ID,
    clientSecret: process.env.CX3_CLIENT_SECRET,
    appDn: process.env.CX3_APP_DN || process.env.CX3_CLIENT_ID,
  },
};

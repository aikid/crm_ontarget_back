const path = require("node:path");
const dotenv = require("dotenv");
const { originList } = require("./origins");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL não configurada. Adicione a URL de conexão PostgreSQL ao arquivo backend/.env.",
  );
}

const sessionSameSite = process.env.SESSION_COOKIE_SAME_SITE || "lax";
const sessionSecure = process.env.SESSION_COOKIE_SECURE
  ? process.env.SESSION_COOKIE_SECURE === "true"
  : (process.env.NODE_ENV || "development") === "production";

module.exports = {
  port: Number(process.env.PORT || 3333),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  frontendUrls: originList(process.env.FRONTEND_URL, ["http://localhost:3000", "http://localhost:5173"]),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  session: {
    cookieName: process.env.SESSION_COOKIE_NAME || "ontarget.sid",
    ttlHours: Number(process.env.SESSION_TTL_HOURS || 12),
    sameSite: sessionSameSite,
    secure: sessionSecure,
    partitioned: process.env.SESSION_COOKIE_PARTITIONED
      ? process.env.SESSION_COOKIE_PARTITIONED === "true"
      : sessionSecure && sessionSameSite.toLowerCase() === "none",
  },
  asterisk: {
    enabled: process.env.ASTERISK_ENABLED === "true",
    ariHttpUrl: (process.env.ARI_HTTP_URL || "http://127.0.0.1:18088").replace(/\/$/, ""),
    ariWsUrl: (process.env.ARI_WS_URL || "ws://127.0.0.1:18088").replace(/\/$/, ""),
    ariApp: process.env.ARI_APP || "crm_browser_poc",
    ariUser: process.env.ARI_USER,
    ariPassword: process.env.ARI_PASSWORD,
    sipWebSocketUrl: process.env.ASTERISK_SIP_WSS_URL,
    sipDomain: process.env.ASTERISK_SIP_DOMAIN,
    sipAccountsJson: process.env.ASTERISK_SIP_ACCOUNTS_JSON,
    sharedSipExtension: process.env.ASTERISK_SIP_EXTENSION,
    sharedSipPassword: process.env.ASTERISK_SIP_PASSWORD,
    allowSharedSipAccount: process.env.ASTERISK_ALLOW_SHARED_SIP_ACCOUNT === "true",
    internalExtension: process.env.ASTERISK_INTERNAL_EXTENSION || "902",
    webAppArg: process.env.ASTERISK_WEB_APP_ARG || "web201",
    webChannelPrefix: process.env.ASTERISK_WEB_CHANNEL_PREFIX || "PJSIP/201-",
    trunkName: process.env.OVERTELE_TRUNK_NAME || "overtele",
    intentTtlSeconds: Number(process.env.CALL_INTENT_TTL_SECONDS || 30),
    maxCallSeconds: Number(process.env.MAX_CALL_SECONDS || 7_200),
    reconnectMinMs: Number(process.env.ARI_RECONNECT_MIN_MS || 1_000),
    reconnectMaxMs: Number(process.env.ARI_RECONNECT_MAX_MS || 30_000),
  },
  // Legado temporário: removido quando o motor ARI assumir as rotas de telefonia.
  threeCx: {
    pbxUrl: process.env.CX3_PBX_URL || "https://8rtech.my3cx.com.br",
    clientId: process.env.CX3_CLIENT_ID,
    clientSecret: process.env.CX3_CLIENT_SECRET,
    appDn: process.env.CX3_APP_DN || process.env.CX3_CLIENT_ID,
  },
};

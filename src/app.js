const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const env = require("./config/env");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const importRoutes = require("./routes/imports");
const catalogRoutes = require("./routes/catalog");
const campaignRoutes = require("./routes/campaigns");
const leadRoutes = require("./routes/leads");
const sdrRoutes = require("./routes/sdr");
const telephonyRoutes = require("./routes/telephony");
const operationRoutes = require("./routes/operations");
const { requireAuth } = require("./middleware/auth");
const { notFound, errorHandler } = require("./middleware/errors");

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.frontendUrls, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_request, response) => response.json({ status: "ok", service: "ontarget-api" }));
app.use("/api/auth", authRoutes);
app.use("/api/admin/imports", requireAuth, importRoutes);
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api", requireAuth, catalogRoutes);
app.use("/api/campaigns", requireAuth, campaignRoutes);
app.use("/api/leads", requireAuth, leadRoutes);
app.use("/api/sdr", requireAuth, sdrRoutes);
app.use("/api/telephony", telephonyRoutes);
app.use("/api/operations", requireAuth, operationRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;

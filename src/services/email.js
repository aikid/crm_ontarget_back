const nodemailer = require("nodemailer");
const env = require("../config/env");
const { HttpError } = require("../lib/http-error");

let transporter;

function isEmailConfigured() {
  if (env.email.jsonTransport) return Boolean(env.email.from);
  const credentialsComplete = (!env.email.user && !env.email.password)
    || Boolean(env.email.user && env.email.password);
  return Boolean(env.email.host && env.email.from && credentialsComplete);
}

function requireEmailConfiguration() {
  if (!isEmailConfigured()) {
    throw new HttpError(503, "O envio de e-mail ainda não está configurado. Configure o SMTP no Render.");
  }
}

function transport() {
  requireEmailConfiguration();
  if (!transporter) {
    transporter = nodemailer.createTransport(env.email.jsonTransport ? { jsonTransport: true } : {
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      ...(env.email.user ? { auth: { user: env.email.user, pass: env.email.password } } : {}),
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function passwordUrl(token, role) {
  const base = env.email.resetUrl || env.frontendUrls[0];
  const url = new URL(role === "CLIENT" ? "/cliente" : "/", base);
  url.searchParams.set("resetToken", token);
  return url.toString();
}

async function sendPasswordEmail({ user, token, access = false }) {
  const url = passwordUrl(token, user.role);
  const title = access ? "Defina seu acesso ao SysOn" : "Recupere sua senha do SysOn";
  const action = access ? "Definir minha senha" : "Criar nova senha";
  const intro = access
    ? "Seu acesso foi criado. Use o botão abaixo para definir sua senha."
    : "Recebemos uma solicitação para redefinir sua senha.";

  await transport().sendMail({
    from: env.email.from,
    to: user.email,
    subject: title,
    text: `${intro}\n\n${action}: ${url}\n\nO link expira em ${env.email.resetTtlMinutes} minutos. Se você não solicitou esta alteração, ignore este e-mail.`,
    html: `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f5f6;font-family:Arial,sans-serif;color:#202127"><div style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:16px"><p style="color:#e8202a;font-weight:700;letter-spacing:.08em">SYSON</p><h1 style="font-size:24px">${escapeHtml(title)}</h1><p>Olá, ${escapeHtml(user.name)}.</p><p>${escapeHtml(intro)}</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 20px;border-radius:9px;background:#e8202a;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(action)}</a></p><p style="font-size:13px;color:#6d7078">Este link expira em ${env.email.resetTtlMinutes} minutos e só pode ser usado uma vez.</p><p style="font-size:13px;color:#6d7078">Se você não solicitou esta alteração, ignore este e-mail.</p></div></body></html>`,
  });
}

module.exports = { isEmailConfigured, requireEmailConfiguration, sendPasswordEmail };

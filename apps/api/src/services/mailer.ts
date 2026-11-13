import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import nodemailer from "nodemailer";

import { appEnv } from "../config/env.js";

type PasswordResetMail = {
  resetToken: string;
  toEmail: string;
  toName?: string | null;
};

type PasswordChangedMail = {
  source: "profile" | "reset";
  toEmail: string;
  toName?: string | null;
};

type SendMailPayload = {
  html: string;
  subject: string;
  text: string;
  to: string;
};

let transporterPromise: Promise<nodemailer.Transporter> | null = null;

function sanitizeHeader(value: string): string {
  return String(value).replace(/[\r\n]/gu, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function resolveDefaultFromAddress(): string {
  if (appEnv.smtpFromAddress) {
    return appEnv.smtpFromAddress;
  }

  try {
    const hostname = new URL(appEnv.webOrigin).hostname;
    if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
      return `conejolector_noreply@${hostname}`;
    }
  } catch {
    // Fallback below.
  }

  return "conejolector_noreply@cerroserver.dev";
}

function resolveSendmailBinary(): string | null {
  if (existsSync("/usr/sbin/sendmail")) {
    return "/usr/sbin/sendmail";
  }

  if (existsSync("/usr/lib/sendmail")) {
    return "/usr/lib/sendmail";
  }

  return "sendmail";
}

async function sendViaSendmail(payload: SendMailPayload, fromHeader: string): Promise<void> {
  const sanitizedTo = sanitizeHeader(payload.to);
  const sanitizedFrom = sanitizeHeader(fromHeader);
  const sanitizedSubject = sanitizeHeader(payload.subject);

  if (!sanitizedTo || !sanitizedTo.includes("@") || sanitizedTo.length < 3) {
    throw Object.assign(new Error("La dirección de correo del destinatario no es válida."), {
      statusCode: 400
    });
  }

  const sendmailBinary = resolveSendmailBinary();
  if (!sendmailBinary) {
    throw Object.assign(new Error("El envío de correo no está disponible en este servidor."), {
      statusCode: 503
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(sendmailBinary, ["-t"]);
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      console.error("Error ejecutando sendmail:", error);
      reject(Object.assign(new Error("El envío de correo no está disponible en este servidor."), {
        statusCode: 503
      }));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      console.error(`sendmail falló con código ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
      reject(Object.assign(new Error("No se pudo enviar el correo electrónico."), {
        statusCode: 503
      }));
    });

    child.stdin.write(`To: ${sanitizedTo}\n`);
    child.stdin.write(`From: ${sanitizedFrom}\n`);
    child.stdin.write('Content-Type: text/html; charset="UTF-8"\n');
    child.stdin.write(`Subject: ${sanitizedSubject}\n\n`);
    child.stdin.write(payload.html);
    child.stdin.end();
  });
}

async function getSmtpOrPreviewTransporter(): Promise<nodemailer.Transporter | null> {
  if (appEnv.smtpHost && appEnv.smtpUser && appEnv.smtpPassword && appEnv.smtpFromAddress) {
    if (!transporterPromise) {
      transporterPromise = Promise.resolve(
        nodemailer.createTransport({
          auth: {
            pass: appEnv.smtpPassword,
            user: appEnv.smtpUser
          },
          host: appEnv.smtpHost,
          port: appEnv.smtpPort,
          secure: appEnv.smtpSecure
        })
      );
    }

    return transporterPromise;
  }

  if (appEnv.nodeEnv !== "production") {
    if (!transporterPromise) {
      transporterPromise = Promise.resolve(
        nodemailer.createTransport({
          buffer: true,
          newline: "unix",
          streamTransport: true
        })
      );
    }

    return transporterPromise;
  }

  return null;
}

async function sendMailMessage(payload: SendMailPayload): Promise<void> {
  const fromAddress = resolveDefaultFromAddress();
  const fromHeader = `${sanitizeHeader(appEnv.smtpFromName)} <${sanitizeHeader(fromAddress)}>`;
  const transporter = await getSmtpOrPreviewTransporter();

  if (!transporter) {
    await sendViaSendmail(payload, fromHeader);
    return;
  }

  const info = await transporter.sendMail({
    from: fromHeader,
    html: payload.html,
    subject: sanitizeHeader(payload.subject),
    text: payload.text,
    to: sanitizeHeader(payload.to)
  });

  if (!appEnv.smtpHost) {
    const previewMessage = typeof info.message === "string"
      ? info.message
      : Buffer.isBuffer(info.message)
        ? info.message.toString("utf-8")
        : payload.text;

    console.info(`[mail-preview] ${payload.to} -> ${payload.subject}`);
    console.info(previewMessage);
  }
}

export async function sendPasswordResetEmail(payload: PasswordResetMail): Promise<void> {
  const resetUrl = `${appEnv.passwordResetUrlBase}?token=${encodeURIComponent(payload.resetToken)}`;
  const greetingName = payload.toName?.trim() || payload.toEmail;
  const safeGreetingName = escapeHtml(greetingName);
  const safeResetUrl = escapeHtml(resetUrl);

  await sendMailMessage({
    html: `
      <h2>Recuperación de contraseña</h2>
      <p>Hola ${safeGreetingName},</p>
      <p>Hemos recibido una solicitud para restablecer tu contraseña de <strong>El conejo lector</strong>.</p>
      <p>Haz clic en el siguiente enlace para definir una nueva contraseña:</p>
      <p><a href="${safeResetUrl}">${safeResetUrl}</a></p>
      <p><strong>Este enlace expirará en 60 minutos.</strong></p>
      <p>Si no solicitaste esta recuperación, puedes ignorar este mensaje.</p>
      <hr>
      <p style="color: #666; font-size: 12px;">
        Por tu seguridad, nunca compartas este enlace con nadie.
      </p>
    `,
    subject: "Recuperación de contraseña - El conejo lector",
    text: [
      `Hola ${greetingName},`,
      "",
      "Hemos recibido una solicitud para restablecer tu contraseña de El conejo lector.",
      `Abre este enlace (caduca en 60 minutos): ${resetUrl}`,
      "",
      "Si no solicitaste esta recuperación, puedes ignorar este mensaje."
    ].join("\n"),
    to: payload.toEmail
  });
}

export async function sendPasswordChangedEmail(payload: PasswordChangedMail): Promise<void> {
  const greetingName = payload.toName?.trim() || payload.toEmail;
  const safeGreetingName = escapeHtml(greetingName);
  const detailText = payload.source === "profile"
    ? "Tu contraseña de El conejo lector ha sido cambiada desde tu perfil."
    : "Tu contraseña de El conejo lector ha sido restablecida correctamente.";

  await sendMailMessage({
    html: `
      <h2>Contraseña actualizada</h2>
      <p>Hola ${safeGreetingName},</p>
      <p>${escapeHtml(detailText)}</p>
      <p>Si no realizaste este cambio, <strong>contacta al administrador inmediatamente</strong>.</p>
      <hr>
      <p style="color: #666; font-size: 12px;">
        Este es un correo automático de confirmación enviado desde El conejo lector.
      </p>
    `,
    subject: "Contraseña actualizada - El conejo lector",
    text: [
      `Hola ${greetingName},`,
      "",
      detailText,
      "Si no realizaste este cambio, contacta al administrador inmediatamente."
    ].join("\n"),
    to: payload.toEmail
  });
}

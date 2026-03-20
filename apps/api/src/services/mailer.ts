import nodemailer from "nodemailer";

import { appEnv } from "../config/env.js";

type PasswordResetMail = {
  resetToken: string;
  toEmail: string;
  toName?: string | null;
};

let transporterPromise: Promise<nodemailer.Transporter> | null = null;

async function getTransporter(): Promise<nodemailer.Transporter> {
  if (transporterPromise) {
    return transporterPromise;
  }

  transporterPromise = Promise.resolve().then(() => {
    if (appEnv.smtpHost && appEnv.smtpUser && appEnv.smtpPassword && appEnv.smtpFromAddress) {
      return nodemailer.createTransport({
        auth: {
          pass: appEnv.smtpPassword,
          user: appEnv.smtpUser
        },
        host: appEnv.smtpHost,
        port: appEnv.smtpPort,
        secure: appEnv.smtpSecure
      });
    }

    if (appEnv.nodeEnv !== "production") {
      return nodemailer.createTransport({
        buffer: true,
        newline: "unix",
        streamTransport: true
      });
    }

    throw Object.assign(new Error("El envío de correo no está configurado."), {
      statusCode: 503
    });
  });

  return transporterPromise;
}

export async function sendPasswordResetEmail(payload: PasswordResetMail): Promise<void> {
  const transporter = await getTransporter();
  const resetUrl = `${appEnv.passwordResetUrlBase}?token=${encodeURIComponent(payload.resetToken)}`;
  const greetingName = payload.toName?.trim() || payload.toEmail;
  const fromAddress = appEnv.smtpFromAddress ?? "no-reply@elconejollector.local";

  const info = await transporter.sendMail({
    from: `${appEnv.smtpFromName} <${fromAddress}>`,
    html: `
      <p>Hola ${greetingName},</p>
      <p>Hemos recibido una solicitud para restablecer tu contraseña de El conejo lector.</p>
      <p><a href="${resetUrl}">Restablecer contraseña</a></p>
      <p>Si no pediste este cambio, puedes ignorar este mensaje.</p>
    `,
    subject: "Recupera tu contraseña de El conejo lector",
    text: [
      `Hola ${greetingName},`,
      "",
      "Hemos recibido una solicitud para restablecer tu contraseña de El conejo lector.",
      `Abre este enlace: ${resetUrl}`,
      "",
      "Si no pediste este cambio, puedes ignorar este mensaje."
    ].join("\n"),
    to: payload.toEmail
  });

  if (!appEnv.smtpHost) {
    const previewMessage = typeof info.message === "string"
      ? info.message
      : Buffer.isBuffer(info.message)
        ? info.message.toString("utf-8")
        : resetUrl;

    console.info(`[mail-preview] ${payload.toEmail} -> ${resetUrl}`);
    console.info(previewMessage);
  }
}
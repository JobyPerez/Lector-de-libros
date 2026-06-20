import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { appEnv } from "../config/env.js";

const encryptionAlgorithm = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  return createHash("sha256").update(appEnv.aiCredentialsEncryptionKey, "utf8").digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(encryptionAlgorithm, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [ivValue, authTagValue, encryptedValue] = value.split(".");
  if (!ivValue || !authTagValue || !encryptedValue) {
    throw new Error("Formato de secreto cifrado no valido.");
  }

  const decipher = createDecipheriv(encryptionAlgorithm, getEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

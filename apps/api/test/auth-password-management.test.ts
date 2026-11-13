import assert from "node:assert/strict";
import test from "node:test";

import {
  changePasswordSchema,
  checkPasswordRecoveryRateLimit,
  forgotPasswordSchema,
  resetPasswordRecoveryRateLimitForTests,
  resetPasswordSchema
} from "../src/modules/auth/auth.routes.js";
import { sendPasswordChangedEmail, sendPasswordResetEmail } from "../src/services/mailer.js";

test("changePasswordSchema valida longitud mínima y coincidencia de contraseñas", () => {
  assert.equal(changePasswordSchema.safeParse({
    confirmPassword: "NuevaPassword123",
    currentPassword: "ActualPassword123",
    newPassword: "NuevaPassword123"
  }).success, true);

  const shortResult = changePasswordSchema.safeParse({
    confirmPassword: "corta",
    currentPassword: "ActualPassword123",
    newPassword: "corta"
  });
  assert.equal(shortResult.success, false);

  const mismatchResult = changePasswordSchema.safeParse({
    confirmPassword: "OtraPassword123",
    currentPassword: "ActualPassword123",
    newPassword: "NuevaPassword123"
  });
  assert.equal(mismatchResult.success, false);
  assert.equal(mismatchResult.error.issues[0]?.message, "Las contraseñas no coinciden.");
});

test("forgotPasswordSchema y resetPasswordSchema validan correo y token", () => {
  assert.equal(forgotPasswordSchema.safeParse({ email: "  lector@example.com  " }).success, true);
  assert.equal(forgotPasswordSchema.safeParse({ email: "no-es-correo" }).success, false);

  assert.equal(resetPasswordSchema.safeParse({ password: "Password123", token: "abc123" }).success, true);
  assert.equal(resetPasswordSchema.safeParse({ password: "123", token: "abc123" }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ password: "Password123", token: "   " }).success, false);
});

test("checkPasswordRecoveryRateLimit limita a 3 intentos cada 10 minutos por correo", () => {
  resetPasswordRecoveryRateLimitForTests();
  const baseTime = 1_700_000_000_000;

  assert.equal(checkPasswordRecoveryRateLimit("Usuario@Example.com", baseTime), true);
  assert.equal(checkPasswordRecoveryRateLimit("usuario@example.com", baseTime + 1_000), true);
  assert.equal(checkPasswordRecoveryRateLimit("usuario@example.com", baseTime + 2_000), true);
  assert.equal(checkPasswordRecoveryRateLimit("usuario@example.com", baseTime + 3_000), false);

  // Otro correo no queda bloqueado
  assert.equal(checkPasswordRecoveryRateLimit("otro@example.com", baseTime + 3_000), true);

  // Pasados 10 minutos se habilita de nuevo
  assert.equal(checkPasswordRecoveryRateLimit("usuario@example.com", baseTime + 10 * 60 * 1000 + 1), true);
  resetPasswordRecoveryRateLimitForTests();
});

test("mailer genera correos de recuperación y confirmación sin errores en entorno de prueba", async () => {
  await sendPasswordResetEmail({
    resetToken: "token-prueba-123",
    toEmail: "lector@example.com",
    toName: "Lector de Prueba"
  });

  await sendPasswordChangedEmail({
    source: "profile",
    toEmail: "lector@example.com",
    toName: "Lector de Prueba"
  });

  await sendPasswordChangedEmail({
    source: "reset",
    toEmail: "lector@example.com"
  });
});

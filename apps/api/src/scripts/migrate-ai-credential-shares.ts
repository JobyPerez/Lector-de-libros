import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function tableExists(connection: Awaited<ReturnType<typeof getConnection>>, name: string): Promise<boolean> {
  const result = await connection.execute(
    `SELECT COUNT(*) AS "total" FROM user_tables WHERE table_name = :name`,
    { name }
  );
  const [row] = (result.rows ?? []) as Array<{ total: number }>;
  return Number(row?.total ?? 0) > 0;
}

async function main(): Promise<void> {
  const sql = await readFile(new URL("../../sql/036_ai_credential_shares.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) {
      await connection.execute(statement);
    }

    if (!(await tableExists(connection, "AI_CREDENTIAL_SHARES"))) {
      throw new Error("La tabla AI_CREDENTIAL_SHARES no existe tras la migración SQL036.");
    }

    // Backfill: convierte los flags legacy share_*='1' en filas granulares para todos los demás usuarios.
    // share_opencode legacy alimenta tanto OPENCODE_OCR como OPENCODE_SUMMARY.
    const adminsResult = await connection.execute(
      `
      SELECT user_id AS "userId", share_aws AS "shareAws", share_opencode AS "shareOpencode",
             share_google AS "shareGoogle", share_deepgram AS "shareDeepgram"
      FROM users WHERE role = 'ADMIN'
    `
    );
    const admins = (adminsResult.rows ?? []) as Array<{
      userId: string;
      shareAws: string | null;
      shareOpencode: string | null;
      shareGoogle: string | null;
      shareDeepgram: string | null;
    }>;

    const usersResult = await connection.execute(`SELECT user_id AS "userId" FROM users`);
    const allUserIds = ((usersResult.rows ?? []) as Array<{ userId: string }>).map((row) => row.userId);

    let inserted = 0;
    for (const admin of admins) {
      const grants: string[] = [];
      if (String(admin.shareAws) === "1") grants.push("AWS");
      if (String(admin.shareOpencode) === "1") grants.push("OPENCODE_OCR", "OPENCODE_SUMMARY");
      if (String(admin.shareGoogle) === "1") grants.push("GOOGLE");
      if (String(admin.shareDeepgram) === "1") grants.push("DEEPGRAM");
      if (grants.length === 0) continue;

      for (const recipientId of allUserIds) {
        if (recipientId === admin.userId) continue;
        for (const iaType of grants) {
          try {
            const result = await connection.execute(
              `
              INSERT INTO ai_credential_shares (share_id, sharer_user_id, recipient_user_id, ia_type)
              VALUES (:shareId, :sharerUserId, :recipientUserId, :iaType)
            `,
              { shareId: randomUUID(), sharerUserId: admin.userId, recipientUserId: recipientId, iaType }
            );
            inserted += result.rowsAffected ?? 0;
          } catch (error) {
            // ORA-00001 = ya existía la fila; se ignora para idempotencia.
            if ((error as { errorNum?: number }).errorNum !== 1) throw error;
          }
        }
      }
    }

    await connection.commit();
    console.log(`SQL036 verificado: tabla AI_CREDENTIAL_SHARES presente. Filas granulares heredadas: ${inserted}.`);
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error: unknown) => {
  console.error("Fallo de migración SQL036:", error instanceof Error ? error.message : "Error desconocido");
  process.exitCode = 1;
});

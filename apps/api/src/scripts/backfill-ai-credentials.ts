import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";
import { appEnv } from "../config/env.js";
import { encryptSecret } from "../services/secret-crypto.js";

const migrationStatements = [
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'DEEPGRAM_API_KEY_ENCRYPTED';
      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE users ADD (deepgram_api_key_encrypted VARCHAR2(2000 CHAR))';
      END IF;
    END;
  `,
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'DEEPGRAM_TTS_MODEL';
      IF column_count = 0 THEN
        EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (deepgram_tts_model VARCHAR2(100 CHAR))]';
      END IF;
    END;
  `,
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_REGION';
      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_region VARCHAR2(100 CHAR))';
      END IF;
    END;
  `,
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_ACCESS_KEY_ID_ENCRYPTED';
      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_access_key_id_encrypted VARCHAR2(2000 CHAR))';
      END IF;
    END;
  `,
  `
    DECLARE
      column_count NUMBER;
    BEGIN
      SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'AWS_SECRET_ACCESS_KEY_ENCRYPTED';
      IF column_count = 0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE users ADD (aws_secret_access_key_encrypted VARCHAR2(2000 CHAR))';
      END IF;
    END;
  `
];

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();

  try {
    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    await connection.execute(
      `
        UPDATE users
        SET deepgram_api_key_encrypted = COALESCE(deepgram_api_key_encrypted, :deepgramApiKeyEncrypted),
            deepgram_tts_model = COALESCE(deepgram_tts_model, :deepgramTtsModel),
            aws_region = COALESCE(aws_region, :awsRegion),
            aws_access_key_id_encrypted = COALESCE(aws_access_key_id_encrypted, :awsAccessKeyIdEncrypted),
            aws_secret_access_key_encrypted = COALESCE(aws_secret_access_key_encrypted, :awsSecretAccessKeyEncrypted)
      `,
      {
        awsAccessKeyIdEncrypted: appEnv.awsAccessKeyId ? encryptSecret(appEnv.awsAccessKeyId) : null,
        awsRegion: appEnv.awsRegion ?? null,
        awsSecretAccessKeyEncrypted: appEnv.awsSecretAccessKey ? encryptSecret(appEnv.awsSecretAccessKey) : null,
        deepgramApiKeyEncrypted: appEnv.deepgramApiKey ? encryptSecret(appEnv.deepgramApiKey) : null,
        deepgramTtsModel: appEnv.deepgramTtsModel
      },
      { autoCommit: true }
    );

    console.log("Credenciales IA migradas y copiadas a usuarios existentes.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

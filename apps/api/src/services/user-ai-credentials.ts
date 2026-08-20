import { getConnection } from "../config/database.js";
import { appEnv } from "../config/env.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";

export type UserAiCredentialSummary = {
  awsRegion: string | null;
  deepgramTtsModel: string;
  deepgramTtsModelIt: string;
  hasAwsAccessKeyId: boolean;
  hasAwsCredentials: boolean;
  hasAwsSecretAccessKey: boolean;
  hasDeepgramApiKey: boolean;
};

export type UserAiCredentials = UserAiCredentialSummary & {
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
  deepgramApiKey: string | null;
};

type UserAiCredentialRow = {
  awsAccessKeyIdEncrypted: string | null;
  awsRegion: string | null;
  awsSecretAccessKeyEncrypted: string | null;
  deepgramApiKeyEncrypted: string | null;
  deepgramTtsModel: string | null;
  deepgramTtsModelIt: string | null;
};

type DecryptedUserAiCredentials = {
  awsAccessKeyId: string | null;
  awsRegion: string | null;
  awsSecretAccessKey: string | null;
  deepgramApiKey: string | null;
  deepgramTtsModel: string;
  deepgramTtsModelIt: string;
};

function decryptOptionalSecret(value: string | null): string | null {
  return value ? decryptSecret(value) : null;
}

function summarizeUserAiCredentials(credentials: DecryptedUserAiCredentials): UserAiCredentialSummary {
  const hasAwsAccessKeyId = Boolean(credentials.awsAccessKeyId);
  const hasAwsSecretAccessKey = Boolean(credentials.awsSecretAccessKey);

  return {
    awsRegion: credentials.awsRegion,
    deepgramTtsModel: credentials.deepgramTtsModel,
    deepgramTtsModelIt: credentials.deepgramTtsModelIt,
    hasAwsAccessKeyId,
    hasAwsCredentials: Boolean(credentials.awsRegion) && hasAwsAccessKeyId && hasAwsSecretAccessKey,
    hasAwsSecretAccessKey,
    hasDeepgramApiKey: Boolean(credentials.deepgramApiKey)
  };
}

export async function getUserAiCredentials(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<UserAiCredentials> {
  const connection = existingConnection ?? (await getConnection());

  try {
    const result = await connection.execute(
      `
        SELECT
          deepgram_api_key_encrypted AS "deepgramApiKeyEncrypted",
          deepgram_tts_model AS "deepgramTtsModel",
          deepgram_tts_model_it AS "deepgramTtsModelIt",
          aws_region AS "awsRegion",
          aws_access_key_id_encrypted AS "awsAccessKeyIdEncrypted",
          aws_secret_access_key_encrypted AS "awsSecretAccessKeyEncrypted"
        FROM users
        WHERE user_id = :userId
      `,
      { userId }
    );

    const [row] = (result.rows ?? []) as UserAiCredentialRow[];
    if (!row) {
      throw Object.assign(new Error("Usuario no encontrado."), { statusCode: 404 });
    }

    const credentials = {
      awsAccessKeyId: decryptOptionalSecret(row.awsAccessKeyIdEncrypted),
      awsRegion: row.awsRegion,
      awsSecretAccessKey: decryptOptionalSecret(row.awsSecretAccessKeyEncrypted),
      deepgramApiKey: decryptOptionalSecret(row.deepgramApiKeyEncrypted),
      deepgramTtsModel: row.deepgramTtsModel ?? appEnv.deepgramTtsModel,
      deepgramTtsModelIt: row.deepgramTtsModelIt ?? appEnv.deepgramTtsModelIt
    };

    return {
      ...credentials,
      ...summarizeUserAiCredentials(credentials)
    };
  } finally {
    if (!existingConnection) {
      await connection.close();
    }
  }
}

export async function getUserAiCredentialSummary(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<UserAiCredentialSummary> {
  return summarizeUserAiCredentials(await getUserAiCredentials(userId, existingConnection));
}

export function encryptOptionalSecret(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue ? encryptSecret(normalizedValue) : undefined;
}

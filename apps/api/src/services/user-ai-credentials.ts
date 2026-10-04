import { getConnection } from "../config/database.js";
import { appEnv } from "../config/env.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";

export type AiCredentialSource = "own" | "shared" | "env" | "none";

export const SHARED_IA_TYPES = ["AWS", "OPENCODE_OCR", "OPENCODE_SUMMARY", "GOOGLE", "DEEPGRAM"] as const;
export type SharedIaType = (typeof SHARED_IA_TYPES)[number];

export type UserAiCredentialSummary = {
  awsRegion: string | null;
  deepgramTtsModel: string;
  deepgramTtsModelIt: string;
  hasAwsAccessKeyId: boolean;
  hasAwsCredentials: boolean;
  hasAwsSecretAccessKey: boolean;
  hasDeepgramApiKey: boolean;
  hasOpencodeApiKey: boolean;
  hasGeminiApiKey: boolean;
  opencodeOcrModel: string | null;
  opencodeSummaryModel: string | null;
  opencodeOcrVisibleModels: string[];
  opencodeSummaryVisibleModels: string[];
  shareAws: boolean;
  shareOpencode: boolean;
  shareGoogle: boolean;
  shareDeepgram: boolean;
  /** Nuevos flags divididos (OpenCode OCR y resúmenes por separado). */
  shareOpencodeOcr: boolean;
  shareOpencodeSummary: boolean;
  usingSharedAws: boolean;
  /** Alias legacy: true si usa compartida de OCR o de resúmenes. */
  usingSharedOpencode: boolean;
  usingSharedOpencodeOcr: boolean;
  usingSharedOpencodeSummary: boolean;
  usingSharedGoogle: boolean;
  usingSharedDeepgram: boolean;
  sharedAwsBy: string | null;
  /** Alias legacy: OCR ?? resúmenes. */
  sharedOpencodeBy: string | null;
  sharedOpencodeOcrBy: string | null;
  sharedOpencodeSummaryBy: string | null;
  sharedGoogleBy: string | null;
  sharedDeepgramBy: string | null;
  hasEffectiveAws: boolean;
  /** Alias legacy: OCR o resúmenes. */
  hasEffectiveOpencode: boolean;
  hasEffectiveOpencodeOcr: boolean;
  hasEffectiveOpencodeSummary: boolean;
  hasEffectiveGoogle: boolean;
  hasEffectiveDeepgram: boolean;
};

export type UserAiCredentials = UserAiCredentialSummary & {
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
  deepgramApiKey: string | null;
  opencodeApiKey: string | null;
  geminiApiKey: string | null;
};

type UserAiCredentialRow = {
  awsAccessKeyIdEncrypted: string | null;
  awsRegion: string | null;
  awsSecretAccessKeyEncrypted: string | null;
  deepgramApiKeyEncrypted: string | null;
  deepgramTtsModel: string | null;
  deepgramTtsModelIt: string | null;
  opencodeApiKeyEncrypted?: string | null;
  geminiApiKeyEncrypted?: string | null;
  opencodeOcrModel?: string | null;
  opencodeSummaryModel?: string | null;
  opencodeOcrVisibleModels?: string | null;
  opencodeSummaryVisibleModels?: string | null;
  shareAws?: string | number | null;
  shareOpencode?: string | number | null;
  shareGoogle?: string | number | null;
  shareDeepgram?: string | number | null;
};

type DecryptedUserAiCredentials = {
  awsAccessKeyId: string | null;
  awsRegion: string | null;
  awsSecretAccessKey: string | null;
  deepgramApiKey: string | null;
  deepgramTtsModel: string;
  deepgramTtsModelIt: string;
  opencodeApiKey: string | null;
  geminiApiKey: string | null;
  opencodeOcrModel: string | null;
  opencodeSummaryModel: string | null;
  opencodeOcrVisibleModels: string[];
  opencodeSummaryVisibleModels: string[];
  shareAws: boolean;
  shareOpencode: boolean;
  shareGoogle: boolean;
  shareDeepgram: boolean;
};

export type EffectiveUserAiCredentials = DecryptedUserAiCredentials & {
  /** Claves efectivas por propósito (OpenCode dividido en OCR y resúmenes). */
  opencodeOcrApiKey: string | null;
  opencodeSummaryApiKey: string | null;
  sources: {
    aws: AiCredentialSource;
    opencode: AiCredentialSource;
    opencodeOcr: AiCredentialSource;
    opencodeSummary: AiCredentialSource;
    google: AiCredentialSource;
    deepgram: AiCredentialSource;
  };
  sharedBy: {
    aws: string | null;
    opencode: string | null;
    opencodeOcr: string | null;
    opencodeSummary: string | null;
    google: string | null;
    deepgram: string | null;
  };
};

export type AiShareMatrixEntry = {
  recipientUserId: string;
  iaType: SharedIaType;
  sharerUserId: string;
  sharerUsername: string;
};

function decryptOptionalSecret(value: string | null | undefined): string | null {
  return value ? decryptSecret(value) : null;
}

function parseVisibleModels(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

function parseShareFlag(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim();
  return normalized === "1" || normalized.toUpperCase() === "Y" || normalized.toUpperCase() === "TRUE";
}

function summarizeUserAiCredentials(credentials: DecryptedUserAiCredentials): Omit<UserAiCredentialSummary,
  "shareOpencodeOcr" | "shareOpencodeSummary" |
  "usingSharedAws" | "usingSharedOpencode" | "usingSharedOpencodeOcr" | "usingSharedOpencodeSummary" | "usingSharedGoogle" | "usingSharedDeepgram" |
  "sharedAwsBy" | "sharedOpencodeBy" | "sharedOpencodeOcrBy" | "sharedOpencodeSummaryBy" | "sharedGoogleBy" | "sharedDeepgramBy" |
  "hasEffectiveAws" | "hasEffectiveOpencode" | "hasEffectiveOpencodeOcr" | "hasEffectiveOpencodeSummary" | "hasEffectiveGoogle" | "hasEffectiveDeepgram"> {
  const hasAwsAccessKeyId = Boolean(credentials.awsAccessKeyId);
  const hasAwsSecretAccessKey = Boolean(credentials.awsSecretAccessKey);

  return {
    awsRegion: credentials.awsRegion,
    deepgramTtsModel: credentials.deepgramTtsModel,
    deepgramTtsModelIt: credentials.deepgramTtsModelIt,
    hasAwsAccessKeyId,
    hasAwsCredentials: Boolean(credentials.awsRegion) && hasAwsAccessKeyId && hasAwsSecretAccessKey,
    hasAwsSecretAccessKey,
    hasDeepgramApiKey: Boolean(credentials.deepgramApiKey),
    hasOpencodeApiKey: Boolean(credentials.opencodeApiKey),
    hasGeminiApiKey: Boolean(credentials.geminiApiKey),
    opencodeOcrModel: credentials.opencodeOcrModel,
    opencodeSummaryModel: credentials.opencodeSummaryModel,
    opencodeOcrVisibleModels: credentials.opencodeOcrVisibleModels,
    opencodeSummaryVisibleModels: credentials.opencodeSummaryVisibleModels,
    shareAws: credentials.shareAws,
    shareOpencode: credentials.shareOpencode,
    shareGoogle: credentials.shareGoogle,
    shareDeepgram: credentials.shareDeepgram
  };
}

async function readOwnCredentials(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<DecryptedUserAiCredentials> {
  const connection = existingConnection ?? (await getConnection());
  const ownsConnection = !existingConnection;

  try {
    let row: UserAiCredentialRow | undefined;
    try {
      const result = await connection.execute(
        `
        SELECT
          deepgram_api_key_encrypted AS "deepgramApiKeyEncrypted",
          deepgram_tts_model AS "deepgramTtsModel",
          deepgram_tts_model_it AS "deepgramTtsModelIt",
          aws_region AS "awsRegion",
          aws_access_key_id_encrypted AS "awsAccessKeyIdEncrypted",
          aws_secret_access_key_encrypted AS "awsSecretAccessKeyEncrypted",
          opencode_api_key_encrypted AS "opencodeApiKeyEncrypted",
          gemini_api_key_encrypted AS "geminiApiKeyEncrypted",
          opencode_ocr_model AS "opencodeOcrModel",
          opencode_summary_model AS "opencodeSummaryModel",
          opencode_ocr_visible_models AS "opencodeOcrVisibleModels",
          opencode_summary_visible_models AS "opencodeSummaryVisibleModels",
          share_aws AS "shareAws",
          share_opencode AS "shareOpencode",
          share_google AS "shareGoogle",
          share_deepgram AS "shareDeepgram"
        FROM users
        WHERE user_id = :userId
      `,
        { userId }
      );
      [row] = (result.rows ?? []) as UserAiCredentialRow[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ORA-00904/i.test(message)) {
        throw error;
      }
      const legacy = await connection.execute(
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
      [row] = (legacy.rows ?? []) as UserAiCredentialRow[];
    }
    if (!row) {
      throw Object.assign(new Error("Usuario no encontrado."), { statusCode: 404 });
    }

    return {
      awsAccessKeyId: decryptOptionalSecret(row.awsAccessKeyIdEncrypted),
      awsRegion: row.awsRegion,
      awsSecretAccessKey: decryptOptionalSecret(row.awsSecretAccessKeyEncrypted),
      deepgramApiKey: decryptOptionalSecret(row.deepgramApiKeyEncrypted),
      deepgramTtsModel: row.deepgramTtsModel ?? appEnv.deepgramTtsModel,
      deepgramTtsModelIt: row.deepgramTtsModelIt ?? appEnv.deepgramTtsModelIt,
      opencodeApiKey: decryptOptionalSecret(row.opencodeApiKeyEncrypted),
      geminiApiKey: decryptOptionalSecret(row.geminiApiKeyEncrypted),
      opencodeOcrModel: row.opencodeOcrModel ?? null,
      opencodeSummaryModel: row.opencodeSummaryModel ?? null,
      opencodeOcrVisibleModels: parseVisibleModels(row.opencodeOcrVisibleModels),
      opencodeSummaryVisibleModels: parseVisibleModels(row.opencodeSummaryVisibleModels),
      shareAws: parseShareFlag(row.shareAws),
      shareOpencode: parseShareFlag(row.shareOpencode),
      shareGoogle: parseShareFlag(row.shareGoogle),
      shareDeepgram: parseShareFlag(row.shareDeepgram)
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

type SharerKeyRow = {
  username: string;
  userId: string;
  awsAccessKeyId: string | null;
  awsRegion: string | null;
  awsSecretAccessKey: string | null;
  opencodeApiKey: string | null;
  geminiApiKey: string | null;
  deepgramApiKey: string | null;
};

async function readSharerKeys(
  sharerUserId: string,
  existingConnection: Awaited<ReturnType<typeof getConnection>>
): Promise<SharerKeyRow | null> {
  const result = await existingConnection.execute(
    `
      SELECT user_id AS "userId", username AS "username",
             aws_region AS "awsRegion",
             aws_access_key_id_encrypted AS "awsAccessKeyIdEncrypted",
             aws_secret_access_key_encrypted AS "awsSecretAccessKeyEncrypted",
             opencode_api_key_encrypted AS "opencodeApiKeyEncrypted",
             gemini_api_key_encrypted AS "geminiApiKeyEncrypted",
             deepgram_api_key_encrypted AS "deepgramApiKeyEncrypted"
      FROM users WHERE user_id = :sharerUserId
    `,
    { sharerUserId }
  );
  const [row] = (result.rows ?? []) as Array<Record<string, unknown>>;
  if (!row) return null;
  return {
    userId: String(row.userId),
    username: String(row.username ?? ""),
    awsAccessKeyId: decryptOptionalSecret(row.awsAccessKeyIdEncrypted as string | null),
    awsRegion: (row.awsRegion as string | null) ?? null,
    awsSecretAccessKey: decryptOptionalSecret(row.awsSecretAccessKeyEncrypted as string | null),
    opencodeApiKey: decryptOptionalSecret(row.opencodeApiKeyEncrypted as string | null),
    geminiApiKey: decryptOptionalSecret(row.geminiApiKeyEncrypted as string | null),
    deepgramApiKey: decryptOptionalSecret(row.deepgramApiKeyEncrypted as string | null)
  };
}

type RecipientShareRow = {
  iaType: SharedIaType;
  sharerUserId: string;
  sharerUsername: string;
};

async function listRecipientShares(
  recipientUserId: string,
  existingConnection: Awaited<ReturnType<typeof getConnection>>
): Promise<RecipientShareRow[]> {
  try {
    const result = await existingConnection.execute(
      `
        SELECT s.ia_type AS "iaType", s.sharer_user_id AS "sharerUserId", u.username AS "sharerUsername"
        FROM ai_credential_shares s
        JOIN users u ON u.user_id = s.sharer_user_id
        WHERE s.recipient_user_id = :recipientUserId
          AND u.role = 'ADMIN'
        ORDER BY s.created_at ASC
      `,
      { recipientUserId }
    );
    return ((result.rows ?? []) as Array<{ iaType: string; sharerUserId: string; sharerUsername: string }>)
      .filter((row) => (SHARED_IA_TYPES as readonly string[]).includes(row.iaType))
      .map((row) => ({ iaType: row.iaType as SharedIaType, sharerUserId: row.sharerUserId, sharerUsername: row.sharerUsername }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORA-00942/i.test(message)) return [];
    throw error;
  }
}

type LegacyAdminCandidate = {
  username: string;
  awsAccessKeyId: string | null;
  awsRegion: string | null;
  awsSecretAccessKey: string | null;
  opencodeApiKey: string | null;
  geminiApiKey: string | null;
  deepgramApiKey: string | null;
  shareAws: boolean;
  shareOpencode: boolean;
  shareGoogle: boolean;
  shareDeepgram: boolean;
};

async function findLegacyAdminCandidates(
  excludeUserId: string,
  existingConnection: Awaited<ReturnType<typeof getConnection>>
): Promise<LegacyAdminCandidate[]> {
  try {
    const result = await existingConnection.execute(
      `
        SELECT
          username AS "username",
          aws_region AS "awsRegion",
          aws_access_key_id_encrypted AS "awsAccessKeyIdEncrypted",
          aws_secret_access_key_encrypted AS "awsSecretAccessKeyEncrypted",
          opencode_api_key_encrypted AS "opencodeApiKeyEncrypted",
          gemini_api_key_encrypted AS "geminiApiKeyEncrypted",
          deepgram_api_key_encrypted AS "deepgramApiKeyEncrypted",
          share_aws AS "shareAws",
          share_opencode AS "shareOpencode",
          share_google AS "shareGoogle",
          share_deepgram AS "shareDeepgram"
        FROM users
        WHERE role = 'ADMIN'
          AND user_id != :excludeUserId
          AND (share_aws = '1' OR share_opencode = '1' OR share_google = '1' OR share_deepgram = '1')
        ORDER BY updated_at ASC
      `,
      { excludeUserId }
    );
    const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      username: String(row.username ?? ""),
      awsAccessKeyId: decryptOptionalSecret(row.awsAccessKeyIdEncrypted as string | null),
      awsRegion: (row.awsRegion as string | null) ?? null,
      awsSecretAccessKey: decryptOptionalSecret(row.awsSecretAccessKeyEncrypted as string | null),
      opencodeApiKey: decryptOptionalSecret(row.opencodeApiKeyEncrypted as string | null),
      geminiApiKey: decryptOptionalSecret(row.geminiApiKeyEncrypted as string | null),
      deepgramApiKey: decryptOptionalSecret(row.deepgramApiKeyEncrypted as string | null),
      shareAws: parseShareFlag(row.shareAws as string | null),
      shareOpencode: parseShareFlag(row.shareOpencode as string | null),
      shareGoogle: parseShareFlag(row.shareGoogle as string | null),
      shareDeepgram: parseShareFlag(row.shareDeepgram as string | null)
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORA-00904/i.test(message)) return [];
    throw error;
  }
}

type ResolvedShares = {
  aws: { username: string; awsRegion: string; awsAccessKeyId: string; awsSecretAccessKey: string } | null;
  opencodeOcr: { username: string; opencodeApiKey: string } | null;
  opencodeSummary: { username: string; opencodeApiKey: string } | null;
  google: { username: string; geminiApiKey: string } | null;
  deepgram: { username: string; deepgramApiKey: string } | null;
};

async function resolveRecipientShares(
  recipientUserId: string,
  existingConnection: Awaited<ReturnType<typeof getConnection>>
): Promise<ResolvedShares> {
  const resolved: ResolvedShares = { aws: null, opencodeOcr: null, opencodeSummary: null, google: null, deepgram: null };
  const shareRows = await listRecipientShares(recipientUserId, existingConnection);

  for (const share of shareRows) {
    if (share.iaType === "AWS" && !resolved.aws) {
      const keys = await readSharerKeys(share.sharerUserId, existingConnection);
      if (keys?.awsRegion && keys.awsAccessKeyId && keys.awsSecretAccessKey) {
        resolved.aws = { username: share.sharerUsername, awsRegion: keys.awsRegion, awsAccessKeyId: keys.awsAccessKeyId, awsSecretAccessKey: keys.awsSecretAccessKey };
      }
    } else if (share.iaType === "OPENCODE_OCR" && !resolved.opencodeOcr) {
      const keys = await readSharerKeys(share.sharerUserId, existingConnection);
      if (keys?.opencodeApiKey) {
        resolved.opencodeOcr = { username: share.sharerUsername, opencodeApiKey: keys.opencodeApiKey };
      }
    } else if (share.iaType === "OPENCODE_SUMMARY" && !resolved.opencodeSummary) {
      const keys = await readSharerKeys(share.sharerUserId, existingConnection);
      if (keys?.opencodeApiKey) {
        resolved.opencodeSummary = { username: share.sharerUsername, opencodeApiKey: keys.opencodeApiKey };
      }
    } else if (share.iaType === "GOOGLE" && !resolved.google) {
      const keys = await readSharerKeys(share.sharerUserId, existingConnection);
      if (keys?.geminiApiKey) {
        resolved.google = { username: share.sharerUsername, geminiApiKey: keys.geminiApiKey };
      }
    } else if (share.iaType === "DEEPGRAM" && !resolved.deepgram) {
      const keys = await readSharerKeys(share.sharerUserId, existingConnection);
      if (keys?.deepgramApiKey) {
        resolved.deepgram = { username: share.sharerUsername, deepgramApiKey: keys.deepgramApiKey };
      }
    }
  }

  // Fallback legacy: flags globales share_*='1' (share_opencode alimenta OCR y resúmenes).
  if (!resolved.aws || !resolved.opencodeOcr || !resolved.opencodeSummary || !resolved.google || !resolved.deepgram) {
    const legacy = await findLegacyAdminCandidates(recipientUserId, existingConnection);
    for (const candidate of legacy) {
      if (!resolved.aws && candidate.shareAws && candidate.awsRegion && candidate.awsAccessKeyId && candidate.awsSecretAccessKey) {
        resolved.aws = { username: candidate.username, awsRegion: candidate.awsRegion, awsAccessKeyId: candidate.awsAccessKeyId, awsSecretAccessKey: candidate.awsSecretAccessKey };
      }
      if (!resolved.opencodeOcr && candidate.shareOpencode && candidate.opencodeApiKey) {
        resolved.opencodeOcr = { username: candidate.username, opencodeApiKey: candidate.opencodeApiKey };
      }
      if (!resolved.opencodeSummary && candidate.shareOpencode && candidate.opencodeApiKey) {
        resolved.opencodeSummary = { username: candidate.username, opencodeApiKey: candidate.opencodeApiKey };
      }
      if (!resolved.google && candidate.shareGoogle && candidate.geminiApiKey) {
        resolved.google = { username: candidate.username, geminiApiKey: candidate.geminiApiKey };
      }
      if (!resolved.deepgram && candidate.shareDeepgram && candidate.deepgramApiKey) {
        resolved.deepgram = { username: candidate.username, deepgramApiKey: candidate.deepgramApiKey };
      }
    }
  }

  return resolved;
}

export async function getUserAiCredentials(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<UserAiCredentials> {
  const own = await readOwnCredentials(userId, existingConnection);
  const base = summarizeUserAiCredentials(own);

  return {
    ...own,
    ...base,
    shareOpencodeOcr: base.shareOpencode,
    shareOpencodeSummary: base.shareOpencode,
    usingSharedAws: false,
    usingSharedOpencode: false,
    usingSharedOpencodeOcr: false,
    usingSharedOpencodeSummary: false,
    usingSharedGoogle: false,
    usingSharedDeepgram: false,
    sharedAwsBy: null,
    sharedOpencodeBy: null,
    sharedOpencodeOcrBy: null,
    sharedOpencodeSummaryBy: null,
    sharedGoogleBy: null,
    sharedDeepgramBy: null,
    hasEffectiveAws: base.hasAwsCredentials,
    hasEffectiveOpencode: base.hasOpencodeApiKey,
    hasEffectiveOpencodeOcr: base.hasOpencodeApiKey,
    hasEffectiveOpencodeSummary: base.hasOpencodeApiKey,
    hasEffectiveGoogle: base.hasGeminiApiKey,
    hasEffectiveDeepgram: base.hasDeepgramApiKey
  };
}

export async function getUserAiCredentialSummary(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<UserAiCredentialSummary> {
  const connection = existingConnection ?? (await getConnection());
  const ownsConnection = !existingConnection;

  try {
    const own = await readOwnCredentials(userId, connection);
    const base = summarizeUserAiCredentials(own);

    const hasOwnAws = base.hasAwsCredentials;
    const hasOwnOpencode = base.hasOpencodeApiKey;
    const hasOwnGoogle = base.hasGeminiApiKey;
    const hasOwnDeepgram = base.hasDeepgramApiKey;

    let sharedAwsBy: string | null = null;
    let sharedOpencodeOcrBy: string | null = null;
    let sharedOpencodeSummaryBy: string | null = null;
    let sharedGoogleBy: string | null = null;
    let sharedDeepgramBy: string | null = null;

    if (!hasOwnAws || !hasOwnOpencode || !hasOwnGoogle || !hasOwnDeepgram) {
      const resolved = await resolveRecipientShares(userId, connection);
      if (!hasOwnAws && resolved.aws) sharedAwsBy = resolved.aws.username;
      if (!hasOwnOpencode && resolved.opencodeOcr) sharedOpencodeOcrBy = resolved.opencodeOcr.username;
      if (!hasOwnOpencode && resolved.opencodeSummary) sharedOpencodeSummaryBy = resolved.opencodeSummary.username;
      if (!hasOwnGoogle && resolved.google) sharedGoogleBy = resolved.google.username;
      if (!hasOwnDeepgram && resolved.deepgram) sharedDeepgramBy = resolved.deepgram.username;
    }

    const usingSharedAws = !hasOwnAws && sharedAwsBy !== null;
    const usingSharedOpencodeOcr = !hasOwnOpencode && sharedOpencodeOcrBy !== null;
    const usingSharedOpencodeSummary = !hasOwnOpencode && sharedOpencodeSummaryBy !== null;
    const usingSharedOpencode = usingSharedOpencodeOcr || usingSharedOpencodeSummary;
    const usingSharedGoogle = !hasOwnGoogle && sharedGoogleBy !== null;
    const usingSharedDeepgram = !hasOwnDeepgram && sharedDeepgramBy !== null;
    const sharedOpencodeBy = sharedOpencodeOcrBy ?? sharedOpencodeSummaryBy;

    return {
      ...base,
      shareOpencodeOcr: base.shareOpencode,
      shareOpencodeSummary: base.shareOpencode,
      usingSharedAws,
      usingSharedOpencode,
      usingSharedOpencodeOcr,
      usingSharedOpencodeSummary,
      usingSharedGoogle,
      usingSharedDeepgram,
      sharedAwsBy,
      sharedOpencodeBy,
      sharedOpencodeOcrBy,
      sharedOpencodeSummaryBy,
      sharedGoogleBy,
      sharedDeepgramBy,
      hasEffectiveAws: hasOwnAws || usingSharedAws,
      hasEffectiveOpencode: hasOwnOpencode || usingSharedOpencode || Boolean(appEnv.opencodeGoApiKey),
      hasEffectiveOpencodeOcr: hasOwnOpencode || usingSharedOpencodeOcr || Boolean(appEnv.opencodeGoApiKey),
      hasEffectiveOpencodeSummary: hasOwnOpencode || usingSharedOpencodeSummary || Boolean(appEnv.opencodeGoApiKey),
      hasEffectiveGoogle: hasOwnGoogle || usingSharedGoogle || Boolean(appEnv.geminiApiKey),
      hasEffectiveDeepgram: hasOwnDeepgram || usingSharedDeepgram || Boolean(appEnv.deepgramApiKey)
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getEffectiveUserAiCredentials(
  userId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<EffectiveUserAiCredentials> {
  const connection = existingConnection ?? (await getConnection());
  const ownsConnection = !existingConnection;

  try {
    const own = await readOwnCredentials(userId, connection);
    const resolved = await resolveRecipientShares(userId, connection);

    const hasOwnAws = Boolean(own.awsRegion && own.awsAccessKeyId && own.awsSecretAccessKey);
    const hasOwnOpencode = Boolean(own.opencodeApiKey);
    const hasOwnGoogle = Boolean(own.geminiApiKey);
    const hasOwnDeepgram = Boolean(own.deepgramApiKey);

    const awsRegion = hasOwnAws ? own.awsRegion : (resolved.aws?.awsRegion ?? null);
    const awsAccessKeyId = hasOwnAws ? own.awsAccessKeyId : (resolved.aws?.awsAccessKeyId ?? null);
    const awsSecretAccessKey = hasOwnAws ? own.awsSecretAccessKey : (resolved.aws?.awsSecretAccessKey ?? null);
    const opencodeOcrApiKey = hasOwnOpencode ? own.opencodeApiKey : (resolved.opencodeOcr?.opencodeApiKey ?? appEnv.opencodeGoApiKey ?? null);
    const opencodeSummaryApiKey = hasOwnOpencode ? own.opencodeApiKey : (resolved.opencodeSummary?.opencodeApiKey ?? appEnv.opencodeGoApiKey ?? null);
    const opencodeApiKey = hasOwnOpencode ? own.opencodeApiKey : (resolved.opencodeOcr?.opencodeApiKey ?? resolved.opencodeSummary?.opencodeApiKey ?? appEnv.opencodeGoApiKey ?? null);
    const geminiApiKey = hasOwnGoogle ? own.geminiApiKey : (resolved.google?.geminiApiKey ?? appEnv.geminiApiKey ?? null);
    const deepgramApiKey = hasOwnDeepgram ? own.deepgramApiKey : (resolved.deepgram?.deepgramApiKey ?? appEnv.deepgramApiKey ?? null);

    const sources: EffectiveUserAiCredentials["sources"] = {
      aws: hasOwnAws ? "own" : resolved.aws ? "shared" : "none",
      opencode: hasOwnOpencode ? "own" : resolved.opencodeOcr || resolved.opencodeSummary ? "shared" : appEnv.opencodeGoApiKey ? "env" : "none",
      opencodeOcr: hasOwnOpencode ? "own" : resolved.opencodeOcr ? "shared" : appEnv.opencodeGoApiKey ? "env" : "none",
      opencodeSummary: hasOwnOpencode ? "own" : resolved.opencodeSummary ? "shared" : appEnv.opencodeGoApiKey ? "env" : "none",
      google: hasOwnGoogle ? "own" : resolved.google ? "shared" : appEnv.geminiApiKey ? "env" : "none",
      deepgram: hasOwnDeepgram ? "own" : resolved.deepgram ? "shared" : appEnv.deepgramApiKey ? "env" : "none"
    };

    return {
      ...own,
      awsRegion,
      awsAccessKeyId,
      awsSecretAccessKey,
      opencodeApiKey,
      geminiApiKey,
      deepgramApiKey,
      opencodeOcrApiKey,
      opencodeSummaryApiKey,
      sources,
      sharedBy: {
        aws: hasOwnAws ? null : (resolved.aws?.username ?? null),
        opencode: hasOwnOpencode ? null : (resolved.opencodeOcr?.username ?? resolved.opencodeSummary?.username ?? null),
        opencodeOcr: hasOwnOpencode ? null : (resolved.opencodeOcr?.username ?? null),
        opencodeSummary: hasOwnOpencode ? null : (resolved.opencodeSummary?.username ?? null),
        google: hasOwnGoogle ? null : (resolved.google?.username ?? null),
        deepgram: hasOwnDeepgram ? null : (resolved.deepgram?.username ?? null)
      }
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listAiSharesForSharer(
  sharerUserId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<AiShareMatrixEntry[]> {
  const connection = existingConnection ?? (await getConnection());
  const ownsConnection = !existingConnection;
  try {
    try {
      const result = await connection.execute(
        `
        SELECT s.recipient_user_id AS "recipientUserId", s.ia_type AS "iaType",
               s.sharer_user_id AS "sharerUserId", u.username AS "sharerUsername"
        FROM ai_credential_shares s
        JOIN users u ON u.user_id = s.sharer_user_id
        WHERE s.sharer_user_id = :sharerUserId
      `,
        { sharerUserId }
      );
      return ((result.rows ?? []) as Array<{ recipientUserId: string; iaType: string; sharerUserId: string; sharerUsername: string }>)
        .filter((row) => (SHARED_IA_TYPES as readonly string[]).includes(row.iaType))
        .map((row) => ({ ...row, iaType: row.iaType as SharedIaType }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ORA-00942/i.test(message)) return [];
      throw error;
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function listReceivedAiShares(
  recipientUserId: string,
  existingConnection?: Awaited<ReturnType<typeof getConnection>>
): Promise<AiShareMatrixEntry[]> {
  const connection = existingConnection ?? (await getConnection());
  const ownsConnection = !existingConnection;
  try {
    try {
      const result = await connection.execute(
        `
        SELECT s.recipient_user_id AS "recipientUserId", s.ia_type AS "iaType",
               s.sharer_user_id AS "sharerUserId", u.username AS "sharerUsername"
        FROM ai_credential_shares s
        JOIN users u ON u.user_id = s.sharer_user_id
        WHERE s.recipient_user_id = :recipientUserId AND u.role = 'ADMIN'
      `,
        { recipientUserId }
      );
      return ((result.rows ?? []) as Array<{ recipientUserId: string; iaType: string; sharerUserId: string; sharerUsername: string }>)
        .filter((row) => (SHARED_IA_TYPES as readonly string[]).includes(row.iaType))
        .map((row) => ({ ...row, iaType: row.iaType as SharedIaType }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ORA-00942/i.test(message)) return [];
      throw error;
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function encryptOptionalSecret(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue ? encryptSecret(normalizedValue) : undefined;
}

export function serializeVisibleModels(models: string[] | undefined): string | null {
  if (!models) return null;
  const cleaned = models.map((item) => item.trim()).filter(Boolean);
  return JSON.stringify(cleaned);
}

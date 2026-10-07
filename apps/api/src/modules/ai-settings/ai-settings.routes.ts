import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { AI_MODELS, isFreeZenModelId } from "../../config/ai-models.js";
import { ALLOWED_DEEPGRAM_TTS_MODELS, appEnv } from "../../config/env.js";
import {
  getOpenCodeRequestHeaders,
  OPENCODE_USER_AGENT,
  OPENCODE_ZEN_MODELS_ENDPOINT
} from "../../config/opencode.js";
import { getConnection } from "../../config/database.js";
import {
  SHARED_IA_TYPES,
  encryptOptionalSecret,
  getEffectiveUserAiCredentials,
  getUserAiCredentialSummary,
  getUserAiCredentials,
  listAiSharesForSharer,
  listReceivedAiShares,
  serializeVisibleModels,
  type SharedIaType
} from "../../services/user-ai-credentials.js";
import { recordUserActivity } from "../../services/user-activity.js";
import { authenticateRequest, requireAdministrator, updateProfileSchema } from "../auth/auth.routes.js";

const aiSettingsUpdateSchema = updateProfileSchema.omit({ displayName: true, themeMode: true, themePalette: true }).extend({
  email: z.string().email().optional()
});

const shareUpdateSchema = z.object({
  shareAws: z.boolean(),
  shareDeepgram: z.boolean(),
  shareGoogle: z.boolean(),
  shareOpencode: z.boolean()
});

const opencodeModelsQuerySchema = z.object({
  purpose: z.enum(["ocr", "summary"]).default("ocr")
});

const granularShareUpdateSchema = z.object({
  iaType: z.enum(SHARED_IA_TYPES),
  recipientUserId: z.string().uuid(),
  shared: z.boolean()
});

type ZenModelEntry = {
  id?: string;
  name?: string;
  description?: string;
  context_window?: number;
  contextWindow?: number;
  supports_vision?: boolean;
  supportsVision?: boolean;
  cost?: { input?: number; output?: number };
  pricing?: { input?: number; output?: number };
  price?: { input?: number; output?: number };
};

function parsePriceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/gu, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractModelPrice(entry: ZenModelEntry): number | null {
  const candidates = [
    entry.cost?.input,
    entry.cost?.output,
    entry.pricing?.input,
    entry.pricing?.output,
    entry.price?.input,
    entry.price?.output
  ];
  const numbers = candidates.map(parsePriceNumber).filter((n): n is number => n !== null);
  if (numbers.length === 0) return null;
  return numbers.reduce((a, b) => a + b, 0);
}

function formatZenPricing(entry: ZenModelEntry): string {
  const input = entry.cost?.input ?? entry.pricing?.input ?? entry.price?.input;
  const output = entry.cost?.output ?? entry.pricing?.output ?? entry.price?.output;
  if (input !== undefined || output !== undefined) {
    return `Zen: $${String(input ?? "?")} entrada / $${String(output ?? "?")} salida`;
  }
  return "Precio Zen no publicado";
}

function normalizeZenModels(payload: unknown, purpose: "ocr" | "summary") {
  const list: ZenModelEntry[] = Array.isArray(payload)
    ? (payload as ZenModelEntry[])
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: ZenModelEntry[] }).data as ZenModelEntry[])
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: ZenModelEntry[] }).models as ZenModelEntry[])
        : [];

  // El endpoint /zen/v1/models no publica precios: solo id/object/created.
  // El free tier de Zen ("*-free", "big-pickle", "test") devuelve 403
  // "FreeTierError" fuera del cliente OpenCode, así que se excluye siempre.
  // Sin precios no se puede ordenar por calidad-precio: se priorizan los
  // modelos de pago ya conocidos que funcionan y luego el resto por id.
  const PREFERRED_PAID_ORDER = purpose === "ocr"
    ? ["gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini", "deepseek-v4-flash", "glm-5.3-flash"]
    : ["deepseek-v4-flash", "glm-5.3-flash", "gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini", "deepseek-v4.1-flash", "gemini-3-flash", "glm-5.3"];

  const curatedById = new Map<string, (typeof AI_MODELS)[number]>(AI_MODELS.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const withVision = list
    .map((entry) => ({
      id: String(entry.id ?? "").trim(),
      name: String(entry.name ?? entry.id ?? "").trim(),
      description: String(entry.description ?? "").trim(),
      contextWindowTokens: Number(entry.context_window ?? entry.contextWindow ?? 0) || 0,
      supportsVision: Boolean(entry.supports_vision ?? entry.supportsVision ?? /vision|image|multimodal|gemini|gpt|flash/i.test(`${entry.id ?? ""} ${entry.description ?? ""}`)),
      priceScore: extractModelPrice(entry),
      pricing: formatZenPricing(entry)
    }))
    .filter((entry) => entry.id.length > 0 && !seen.has(entry.id) && (seen.add(entry.id), true))
    .filter((entry) => !isFreeZenModelId(entry.id));

  const filtered = purpose === "ocr" ? withVision.filter((entry) => entry.supportsVision) : withVision;
  const rankOf = (id: string) => {
    const rank = PREFERRED_PAID_ORDER.indexOf(id);
    return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
  };
  filtered.sort((a, b) => {
    const rankDelta = rankOf(a.id) - rankOf(b.id);
    if (rankDelta !== 0) return rankDelta;
    if ((a.priceScore ?? 0) !== (b.priceScore ?? 0)) return (a.priceScore ?? 0) - (b.priceScore ?? 0);
    return a.id.localeCompare(b.id);
  });

  return filtered.slice(0, 5).map((entry) => {
    const curated = curatedById.get(entry.id);
    return {
      id: entry.id,
      name: entry.name || curated?.name || entry.id,
      description: entry.description || curated?.description || (purpose === "ocr" ? "Modelo multimodal apto para OCR." : "Modelo apto para resúmenes."),
      contextWindowTokens: entry.contextWindowTokens || curated?.contextWindowTokens || 0,
      pricing: entry.pricing !== "Precio Zen no publicado" ? entry.pricing : (curated?.pricing ?? "Zen de pago por uso"),
      supportsVision: entry.supportsVision
    };
  });
}

async function syncLegacyShareFlagsToGranularTable(
  connection: Awaited<ReturnType<typeof getConnection>>,
  sharerUserId: string,
  flags: { shareAws: boolean; shareOpencode: boolean; shareGoogle: boolean; shareDeepgram: boolean }
): Promise<void> {
  try {
    const usersResult = await connection.execute(`SELECT user_id AS "userId" FROM users WHERE user_id != :sharerUserId`, { sharerUserId });
    const recipientIds = ((usersResult.rows ?? []) as Array<{ userId: string }>).map((row) => row.userId);
    const desired = new Map<string, Set<string>>();
    for (const recipientId of recipientIds) desired.set(recipientId, new Set<string>());
    if (flags.shareAws) for (const id of recipientIds) desired.get(id)!.add("AWS");
    if (flags.shareOpencode) for (const id of recipientIds) {
      desired.get(id)!.add("OPENCODE_OCR");
      desired.get(id)!.add("OPENCODE_SUMMARY");
    }
    if (flags.shareGoogle) for (const id of recipientIds) desired.get(id)!.add("GOOGLE");
    if (flags.shareDeepgram) for (const id of recipientIds) desired.get(id)!.add("DEEPGRAM");

    for (const recipientId of recipientIds) {
      for (const iaType of SHARED_IA_TYPES) {
        if (desired.get(recipientId)!.has(iaType)) {
          try {
            await connection.execute(
              `INSERT INTO ai_credential_shares (share_id, sharer_user_id, recipient_user_id, ia_type)
               VALUES (:shareId, :sharerUserId, :recipientUserId, :iaType)`,
              { shareId: randomUUID(), sharerUserId, recipientUserId: recipientId, iaType },
              { autoCommit: true }
            );
          } catch (error) {
            if ((error as { errorNum?: number }).errorNum !== 1) throw error;
          }
        } else {
          await connection.execute(
            `DELETE FROM ai_credential_shares
             WHERE sharer_user_id = :sharerUserId AND recipient_user_id = :recipientUserId AND ia_type = :iaType`,
            { sharerUserId, recipientUserId: recipientId, iaType },
            { autoCommit: true }
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORA-00942/i.test(message)) return;
    throw error;
  }
}

function curatedFallback(purpose: "ocr" | "summary") {
  // Solo modelos de pago: los "-free" devuelven 403 fuera del cliente OpenCode.
  const curated = AI_MODELS.filter((model) => !isFreeZenModelId(model.id) && (purpose === "ocr" ? model.supportsVision : true)).slice(0, 5);
  return curated.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    contextWindowTokens: model.contextWindowTokens,
    pricing: model.pricing,
    supportsVision: model.supportsVision
  }));
}

let modelsCache: { expiresAt: number; payloadByPurpose: Record<string, unknown> } | null = null;

export const registerAiSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ai-settings", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const connection = await getConnection();
    try {
      const summary = await getUserAiCredentialSummary(request.currentUser.userId, connection);
      const effective = await getEffectiveUserAiCredentials(request.currentUser.userId, connection);
      return reply.send({
        settings: summary,
        effectiveModels: {
          ocrModel: effective.opencodeOcrModel ?? appEnv.opencodeOcrModel,
          summaryModel: effective.opencodeSummaryModel ?? appEnv.opencodeModel
        },
        isAdmin: request.currentUser.role === "ADMIN"
      });
    } finally {
      await connection.close();
    }
  });

  app.put("/ai-settings", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const payload = aiSettingsUpdateSchema.parse(request.body ?? {});
    const connection = await getConnection();
    const deepgramApiKeyEncrypted = encryptOptionalSecret(payload.deepgramApiKey);
    const awsAccessKeyIdEncrypted = encryptOptionalSecret(payload.awsAccessKeyId);
    const awsSecretAccessKeyEncrypted = encryptOptionalSecret(payload.awsSecretAccessKey);
    const opencodeApiKeyEncrypted = encryptOptionalSecret(payload.opencodeApiKey);
    const geminiApiKeyEncrypted = encryptOptionalSecret(payload.geminiApiKey);
    const opencodeOcrVisibleModels = payload.opencodeOcrVisibleModels ? serializeVisibleModels(payload.opencodeOcrVisibleModels) : null;
    const opencodeSummaryVisibleModels = payload.opencodeSummaryVisibleModels ? serializeVisibleModels(payload.opencodeSummaryVisibleModels) : null;

    try {
      const ownResult = await connection.execute(
        `SELECT email AS "email" FROM users WHERE user_id = :userId`,
        { userId: request.currentUser.userId }
      );
      const [own] = (ownResult.rows ?? []) as Array<{ email: string }>;
      const nextEmail = payload.email ? payload.email.toLowerCase() : (own?.email ?? "");

      await connection.execute(
        `
          UPDATE users
          SET email = :email,
              deepgram_tts_model = COALESCE(:deepgramTtsModel, deepgram_tts_model),
              deepgram_tts_model_it = COALESCE(:deepgramTtsModelIt, deepgram_tts_model_it),
              deepgram_api_key_encrypted = CASE
                WHEN :clearDeepgramApiKey = 1 THEN NULL
                WHEN :deepgramApiKeyEncrypted IS NOT NULL THEN :deepgramApiKeyEncrypted
                ELSE deepgram_api_key_encrypted
              END,
              aws_region = CASE
                WHEN :clearAwsCredentials = 1 THEN NULL
                WHEN :awsRegion IS NOT NULL THEN :awsRegion
                ELSE aws_region
              END,
              aws_access_key_id_encrypted = CASE
                WHEN :clearAwsCredentials = 1 THEN NULL
                WHEN :awsAccessKeyIdEncrypted IS NOT NULL THEN :awsAccessKeyIdEncrypted
                ELSE aws_access_key_id_encrypted
              END,
              aws_secret_access_key_encrypted = CASE
                WHEN :clearAwsCredentials = 1 THEN NULL
                WHEN :awsSecretAccessKeyEncrypted IS NOT NULL THEN :awsSecretAccessKeyEncrypted
                ELSE aws_secret_access_key_encrypted
              END,
              opencode_api_key_encrypted = CASE
                WHEN :clearOpencodeApiKey = 1 THEN NULL
                WHEN :opencodeApiKeyEncrypted IS NOT NULL THEN :opencodeApiKeyEncrypted
                ELSE opencode_api_key_encrypted
              END,
              gemini_api_key_encrypted = CASE
                WHEN :clearGeminiApiKey = 1 THEN NULL
                WHEN :geminiApiKeyEncrypted IS NOT NULL THEN :geminiApiKeyEncrypted
                ELSE gemini_api_key_encrypted
              END,
              opencode_ocr_model = COALESCE(:opencodeOcrModel, opencode_ocr_model),
              opencode_summary_model = COALESCE(:opencodeSummaryModel, opencode_summary_model)
          WHERE user_id = :userId
        `,
        {
          awsAccessKeyIdEncrypted: awsAccessKeyIdEncrypted ?? null,
          awsRegion: payload.awsRegion ?? null,
          awsSecretAccessKeyEncrypted: awsSecretAccessKeyEncrypted ?? null,
          clearAwsCredentials: payload.clearAwsCredentials ? 1 : 0,
          clearDeepgramApiKey: payload.clearDeepgramApiKey ? 1 : 0,
          clearGeminiApiKey: payload.clearGeminiApiKey ? 1 : 0,
          clearOpencodeApiKey: payload.clearOpencodeApiKey ? 1 : 0,
          deepgramApiKeyEncrypted: deepgramApiKeyEncrypted ?? null,
          deepgramTtsModel: payload.deepgramTtsModel ?? null,
          deepgramTtsModelIt: payload.deepgramTtsModelIt ?? null,
          email: nextEmail,
          geminiApiKeyEncrypted: geminiApiKeyEncrypted ?? null,
          opencodeApiKeyEncrypted: opencodeApiKeyEncrypted ?? null,
          opencodeOcrModel: payload.opencodeOcrModel ?? null,
          opencodeSummaryModel: payload.opencodeSummaryModel ?? null,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      // Las columnas opencode_*_visible_models son CLOB: no se pueden mezclar
      // con binds VARCHAR2 dentro de un COALESCE (ORA-00932). Se actualizan
      // por separado con asignación directa, que sí permite VARCHAR2 -> CLOB.
      if (opencodeOcrVisibleModels !== null) {
        try {
          await connection.execute(
            `UPDATE users SET opencode_ocr_visible_models = :visibleModels WHERE user_id = :userId`,
            { userId: request.currentUser.userId, visibleModels: opencodeOcrVisibleModels },
            { autoCommit: true }
          );
        } catch (clobError) {
          const message = clobError instanceof Error ? clobError.message : String(clobError);
          if (!/ORA-00904/i.test(message)) {
            throw clobError;
          }
        }
      }
      if (opencodeSummaryVisibleModels !== null) {
        try {
          await connection.execute(
            `UPDATE users SET opencode_summary_visible_models = :visibleModels WHERE user_id = :userId`,
            { userId: request.currentUser.userId, visibleModels: opencodeSummaryVisibleModels },
            { autoCommit: true }
          );
        } catch (clobError) {
          const message = clobError instanceof Error ? clobError.message : String(clobError);
          if (!/ORA-00904/i.test(message)) {
            throw clobError;
          }
        }
      }

      await recordUserActivity(connection, {
        action: "PROFILE_UPDATED",
        ipAddress: request.ip ?? null,
        userAgent: request.headers["user-agent"] ?? null,
        userId: request.currentUser.userId
      });

      const summary = await getUserAiCredentialSummary(request.currentUser.userId, connection);
      return reply.send({ settings: summary });
    } catch (error) {
      if ((error as { errorNum?: number }).errorNum === 1) {
        return reply.status(409).send({ message: "Ya existe un usuario con ese correo." });
      }
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.put("/ai-settings/share", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const payload = shareUpdateSchema.parse(request.body ?? {});
    const connection = await getConnection();
    try {
      await connection.execute(
        `
          UPDATE users
          SET share_aws = :shareAws,
              share_opencode = :shareOpencode,
              share_google = :shareGoogle,
              share_deepgram = :shareDeepgram
          WHERE user_id = :userId
        `,
        {
          shareAws: payload.shareAws ? "1" : "0",
          shareDeepgram: payload.shareDeepgram ? "1" : "0",
          shareGoogle: payload.shareGoogle ? "1" : "0",
          shareOpencode: payload.shareOpencode ? "1" : "0",
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );
      await syncLegacyShareFlagsToGranularTable(connection, request.currentUser.userId, payload);
      const summary = await getUserAiCredentialSummary(request.currentUser.userId, connection);
      return reply.send({ settings: summary });
    } finally {
      await connection.close();
    }
  });

  app.get("/ai-settings/shares", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const connection = await getConnection();
    try {
      if (request.currentUser.role === "ADMIN") {
        const myShares = await listAiSharesForSharer(request.currentUser.userId, connection);
        return reply.send({ myShares });
      }
      const received = await listReceivedAiShares(request.currentUser.userId, connection);
      return reply.send({ received });
    } finally {
      await connection.close();
    }
  });

  app.put("/ai-settings/shares", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const payload = granularShareUpdateSchema.parse(request.body ?? {});
    const connection = await getConnection();
    try {
      if (payload.recipientUserId === request.currentUser.userId) {
        return reply.status(422).send({ message: "No puedes compartir una IA contigo mismo." });
      }
      const recipientResult = await connection.execute(
        `SELECT user_id AS "userId" FROM users WHERE user_id = :recipientUserId`,
        { recipientUserId: payload.recipientUserId }
      );
      if (((recipientResult.rows ?? []) as unknown[]).length === 0) {
        return reply.status(404).send({ message: "Usuario destinatario no encontrado." });
      }

      const own = await getUserAiCredentials(request.currentUser.userId, connection);
      const hasOwnKey = payload.iaType === "AWS"
        ? own.hasAwsCredentials
        : payload.iaType === "GOOGLE"
          ? own.hasGeminiApiKey
          : payload.iaType === "DEEPGRAM"
            ? own.hasDeepgramApiKey
            : own.hasOpencodeApiKey;
      if (!hasOwnKey) {
        const label = payload.iaType === "AWS" ? "AWS"
          : payload.iaType === "GOOGLE" ? "Google"
          : payload.iaType === "DEEPGRAM" ? "Deepgram" : "OpenCode";
        return reply.status(422).send({ message: `Configura primero tu propia clave de ${label} en Configuración IA antes de compartirla.` });
      }

      if (payload.shared) {
        try {
          await connection.execute(
            `
            INSERT INTO ai_credential_shares (share_id, sharer_user_id, recipient_user_id, ia_type)
            VALUES (:shareId, :sharerUserId, :recipientUserId, :iaType)
          `,
            {
              shareId: randomUUID(),
              sharerUserId: request.currentUser.userId,
              recipientUserId: payload.recipientUserId,
              iaType: payload.iaType
            },
            { autoCommit: true }
          );
        } catch (error) {
          if ((error as { errorNum?: number }).errorNum !== 1) throw error;
        }
      } else {
        await connection.execute(
          `
          DELETE FROM ai_credential_shares
          WHERE sharer_user_id = :sharerUserId AND recipient_user_id = :recipientUserId AND ia_type = :iaType
        `,
          {
            sharerUserId: request.currentUser.userId,
            recipientUserId: payload.recipientUserId,
            iaType: payload.iaType
          },
          { autoCommit: true }
        );
      }

      const myShares = await listAiSharesForSharer(request.currentUser.userId, connection);
      return reply.send({ myShares });
    } finally {
      await connection.close();
    }
  });

  app.get("/ai-settings/opencode-models", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }
    const query = opencodeModelsQuerySchema.parse(request.query ?? {});
    const cacheKey = query.purpose;
    if (modelsCache && modelsCache.expiresAt > Date.now() && modelsCache.payloadByPurpose[cacheKey]) {
      return reply.send(modelsCache.payloadByPurpose[cacheKey]);
    }

    const effective = await getEffectiveUserAiCredentials(request.currentUser.userId);
    const apiKey = (query.purpose === "ocr" ? effective.opencodeOcrApiKey : effective.opencodeSummaryApiKey)
      ?? effective.opencodeApiKey ?? appEnv.opencodeGoApiKey;
    if (!apiKey) {
      return reply.status(503).send({
        code: "MISSING_OPENCODE",
        message: "Te falta la clave de OpenCode. Rellénala en Configuración IA (/ai-settings) o usa la compartida del administrador.",
        models: curatedFallback(query.purpose),
        source: "curated"
      });
    }

    try {
      const response = await fetch(OPENCODE_ZEN_MODELS_ENDPOINT, {
        method: "GET",
        headers: {
          ...getOpenCodeRequestHeaders(apiKey),
          "User-Agent": OPENCODE_USER_AGENT
        }
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw Object.assign(new Error(`OpenCode devolvió ${response.status} al listar modelos. ${body.slice(0, 200)}`.trim()), {
          statusCode: 502
        });
      }
      const payload = (await response.json()) as unknown;
      const models = normalizeZenModels(payload, query.purpose);
      const result = {
        models: models.length > 0 ? models : curatedFallback(query.purpose),
        source: models.length > 0 ? "live" : "curated",
        purpose: query.purpose
      };
      modelsCache = {
        expiresAt: Date.now() + 60 * 60 * 1000,
        payloadByPurpose: { ...(modelsCache?.payloadByPurpose ?? {}), [cacheKey]: result }
      };
      return reply.send(result);
    } catch (error) {
      return reply.send({
        models: curatedFallback(query.purpose),
        source: "curated",
        purpose: query.purpose,
        warning: error instanceof Error ? error.message : "No se pudo refrescar desde OpenCode. Mostrando lista curada."
      });
    }
  });

  app.get("/ai-settings/voices", { preHandler: authenticateRequest }, async (_request, reply) => {
    return reply.send({
      allowed: [...ALLOWED_DEEPGRAM_TTS_MODELS],
      defaults: { es: appEnv.deepgramTtsModel, it: appEnv.deepgramTtsModelIt }
    });
  });
}

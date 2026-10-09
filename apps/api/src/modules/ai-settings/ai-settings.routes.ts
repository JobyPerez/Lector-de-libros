import { createHash, randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { AI_MODELS, isFreeZenModelId, resolveModelVisionCapability } from "../../config/ai-models.js";
import { ALLOWED_DEEPGRAM_TTS_MODELS, appEnv } from "../../config/env.js";
import { fetchModelMetadata } from "../../config/opencode-model-metadata.js";
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
  getSharedOnlyOcrModelId,
  getSharedOnlySummaryModelId,
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
  email: z.string().email().optional(),
  opencodeOcrModel: updateProfileSchema.shape.opencodeOcrModel.unwrap().nullable().optional(),
  opencodeSummaryModel: updateProfileSchema.shape.opencodeSummaryModel.unwrap().nullable().optional()
});

const shareUpdateSchema = z.object({
  shareAws: z.boolean(),
  shareDeepgram: z.boolean(),
  shareGoogle: z.boolean(),
  shareOpencode: z.boolean()
});

const opencodeModelsQuerySchema = z.object({
  purpose: z.enum(["ocr", "summary"]).default("ocr"),
  refresh: z.enum(["true", "false"]).optional()
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
  modalities?: { input?: unknown[]; output?: unknown[] };
  limit?: { context?: number };
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

function zenModelEntries(payload: unknown): ZenModelEntry[] {
  const list = Array.isArray(payload)
    ? (payload as ZenModelEntry[])
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: ZenModelEntry[] }).data as ZenModelEntry[])
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: ZenModelEntry[] }).models as ZenModelEntry[])
        : [];
  return list.filter((entry): entry is ZenModelEntry => entry !== null && typeof entry === "object" && typeof entry.id === "string");
}

type ModelMetadata = { opencode?: { models?: Record<string, ZenModelEntry> } };

function modalityVision(entry: ZenModelEntry | undefined): boolean | undefined {
  if (!Array.isArray(entry?.modalities?.input) || !Array.isArray(entry?.modalities?.output)) return undefined;
  return entry.modalities.input.includes("image") && entry.modalities.output.includes("text");
}

export function normalizeZenModels(payload: unknown, purpose: "ocr" | "summary", metadata: unknown = {}) {
  const list = zenModelEntries(payload);
  const metadataModels = (metadata as ModelMetadata | null)?.opencode?.models;

  // El endpoint /zen/v1/models no publica precios: solo id/object/created.
  // El free tier de Zen ("*-free", "big-pickle", "test") devuelve 403
  // "FreeTierError" fuera del cliente OpenCode, así que se excluye siempre.
  // Sin precios no se puede ordenar por calidad-precio: se priorizan los
  // modelos de pago ya conocidos que funcionan y luego el resto por id.
  const PREFERRED_PAID_ORDER = purpose === "ocr"
    ? ["gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini", "gemini-3-flash"]
    : ["deepseek-v4-flash", "glm-5.3-flash", "gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini", "deepseek-v4.1-flash", "gemini-3-flash", "glm-5.3"];

  const curatedById = new Map<string, (typeof AI_MODELS)[number]>(AI_MODELS.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const withVision = list
    .map((entry) => {
      const id = entry.id!;
      const known = metadataModels && Object.hasOwn(metadataModels, id) ? metadataModels[id] : undefined;
      const explicit = typeof entry.supports_vision === "boolean" ? entry.supports_vision : entry.supportsVision;
      const capability = typeof explicit === "boolean" ? explicit : modalityVision(entry) ?? modalityVision(known);
      const enriched = { ...known, ...entry };
      return {
        id,
        name: String(entry.name ?? known?.name ?? id).trim(),
        description: String(entry.description ?? known?.description ?? "").trim(),
        contextWindowTokens: Number(entry.context_window ?? entry.contextWindow ?? known?.limit?.context ?? 0) || 0,
        supportsVision: purpose === "ocr" ? capability === true : resolveModelVisionCapability(id, explicit) === true,
        priceScore: extractModelPrice(enriched),
        pricing: formatZenPricing(enriched)
      };
    })
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

  return (purpose === "ocr" ? filtered : filtered.slice(0, 5)).map((entry) => {
    const curated = purpose === "summary" ? curatedById.get(entry.id) : undefined;
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

const modelsCache = new Map<string, { expiresAt: number; payload: unknown }>();
const catalogueCacheMs = 5 * 60 * 1000;

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
    const deepgramApiKeyEncrypted = encryptOptionalSecret(payload.deepgramApiKey);
    const awsAccessKeyIdEncrypted = encryptOptionalSecret(payload.awsAccessKeyId);
    const awsSecretAccessKeyEncrypted = encryptOptionalSecret(payload.awsSecretAccessKey);
    const opencodeApiKeyEncrypted = encryptOptionalSecret(payload.opencodeApiKey);
    const geminiApiKeyEncrypted = encryptOptionalSecret(payload.geminiApiKey);
    const opencodeOcrVisibleModels = payload.opencodeOcrVisibleModels ? serializeVisibleModels(payload.opencodeOcrVisibleModels) : null;
    const opencodeSummaryVisibleModels = payload.opencodeSummaryVisibleModels ? serializeVisibleModels(payload.opencodeSummaryVisibleModels) : null;
    const connection = await getConnection();

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
              opencode_ocr_model = CASE WHEN :hasOpencodeOcrModel = 1 THEN :opencodeOcrModel ELSE opencode_ocr_model END,
              opencode_summary_model = CASE WHEN :hasOpencodeSummaryModel = 1 THEN :opencodeSummaryModel ELSE opencode_summary_model END
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
          hasOpencodeOcrModel: payload.opencodeOcrModel !== undefined ? 1 : 0,
          hasOpencodeSummaryModel: payload.opencodeSummaryModel !== undefined ? 1 : 0,
          opencodeOcrModel: payload.opencodeOcrModel ?? null,
          opencodeSummaryModel: payload.opencodeSummaryModel ?? null,
          userId: request.currentUser.userId
        }
      );

      // Las columnas opencode_*_visible_models son CLOB: no se pueden mezclar
      // con binds VARCHAR2 dentro de un COALESCE (ORA-00932). Se actualizan
      // por separado con asignación directa, que sí permite VARCHAR2 -> CLOB.
      if (opencodeOcrVisibleModels !== null) {
        await connection.execute(
          `UPDATE users SET opencode_ocr_visible_models = :visibleModels WHERE user_id = :userId`,
          { userId: request.currentUser.userId, visibleModels: opencodeOcrVisibleModels }
        );
      }
      if (opencodeSummaryVisibleModels !== null) {
        await connection.execute(
          `UPDATE users SET opencode_summary_visible_models = :visibleModels WHERE user_id = :userId`,
          { userId: request.currentUser.userId, visibleModels: opencodeSummaryVisibleModels }
        );
      }

      await recordUserActivity(connection, {
        action: "PROFILE_UPDATED",
        ipAddress: request.ip ?? null,
        userAgent: request.headers["user-agent"] ?? null,
        userId: request.currentUser.userId
      });

      const summary = await getUserAiCredentialSummary(request.currentUser.userId, connection);
      await connection.commit();
      return reply.send({ settings: summary });
    } catch (error) {
      await connection.rollback();
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
    const effective = await getEffectiveUserAiCredentials(request.currentUser.userId);
    const apiKey = (query.purpose === "ocr" ? effective.opencodeOcrApiKey : effective.opencodeSummaryApiKey)
      ?? effective.opencodeApiKey ?? appEnv.opencodeGoApiKey;
    if (!apiKey) {
      return reply.status(503).send({
        code: "MISSING_OPENCODE",
        message: "Te falta la clave de OpenCode. Rellénala en Configuración IA (/ai-settings) o usa la compartida del administrador.",
        models: query.purpose === "ocr" ? [] : curatedFallback(query.purpose),
        source: query.purpose === "ocr" ? "live" : "curated",
        purpose: query.purpose,
        ...(query.purpose === "ocr" ? { liveModelCount: 0, returnedModelCount: 0 } : {})
      });
    }
    const cacheKey = `${request.currentUser.userId}:${query.purpose}:${createHash("sha256").update(apiKey).digest("hex")}`;
    const cached = modelsCache.get(cacheKey);
    if (query.refresh !== "true" && cached && cached.expiresAt > Date.now()) {
      const cachedPayload = cached.payload as { models?: Array<{ id: string }> } & Record<string, unknown>;
      // Aunque haya caché con el catálogo completo, al compartido solo se le muestra su predeterminado.
      const sharedOnlyId = query.purpose === "ocr" ? getSharedOnlyOcrModelId(effective) : getSharedOnlySummaryModelId(effective);
      if (sharedOnlyId && Array.isArray(cachedPayload.models)) {
        return reply.send({ ...cachedPayload, models: cachedPayload.models.filter((model) => model.id === sharedOnlyId), returnedModelCount: cachedPayload.models.filter((model) => model.id === sharedOnlyId).length });
      }
      return reply.send(cached.payload);
    }
    modelsCache.delete(cacheKey);

    try {
      const metadataRequest = query.purpose === "ocr"
        ? fetchModelMetadata(query.refresh === "true").then((payload) => ({ payload, warning: undefined as string | undefined }),
          () => ({ payload: {}, warning: "No se pudieron obtener los metadatos de models.dev; solo se muestran capacidades explicitas de OpenCode." }))
        : Promise.resolve({ payload: {}, warning: undefined });
      const response = await fetch(OPENCODE_ZEN_MODELS_ENDPOINT, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
        headers: {
          ...getOpenCodeRequestHeaders(apiKey),
          "User-Agent": OPENCODE_USER_AGENT
        }
      });
      if (!response.ok) {
        throw Object.assign(new Error(`OpenCode devolvio ${response.status} al listar modelos.`), {
          statusCode: 502
        });
      }
      const payload = (await response.json()) as unknown;
      const metadata = await metadataRequest;
      const allModels = normalizeZenModels(payload, query.purpose, metadata.payload);
      // Compartido = solo el predeterminado del que comparte.
      const sharedOnlyId = query.purpose === "ocr" ? getSharedOnlyOcrModelId(effective) : getSharedOnlySummaryModelId(effective);
      const models = sharedOnlyId ? allModels.filter((model) => model.id === sharedOnlyId) : allModels;
      const liveModelCount = new Set(zenModelEntries(payload).map((entry) => entry.id)).size;
      const result = {
        models: query.purpose === "ocr" || models.length > 0 ? models : curatedFallback(query.purpose),
        source: query.purpose === "ocr" || models.length > 0 ? "live" : "curated",
        purpose: query.purpose,
        liveModelCount,
        returnedModelCount: models.length,
        ...(metadata.warning || (query.purpose === "ocr" && !models.length) ? {
          warning: metadata.warning ?? "OpenCode no publico modelos con entrada de imagen y salida de texto verificadas."
        } : {})
      };
      for (const [key, value] of modelsCache) if (value.expiresAt <= Date.now()) modelsCache.delete(key);
      if (modelsCache.size >= 256) modelsCache.delete(modelsCache.keys().next().value!);
      if (!metadata.warning) modelsCache.set(cacheKey, { expiresAt: Date.now() + catalogueCacheMs, payload: result });
      return reply.send(result);
    } catch (error) {
      const sharedOnlyId = query.purpose === "ocr" ? getSharedOnlyOcrModelId(effective) : getSharedOnlySummaryModelId(effective);
      const fallbackModels = query.purpose === "ocr" ? [] : curatedFallback(query.purpose);
      const models = sharedOnlyId ? fallbackModels.filter((model) => model.id === sharedOnlyId) : fallbackModels;
      return reply.send({
        models,
        source: query.purpose === "ocr" ? "live" : "curated",
        purpose: query.purpose,
        ...(query.purpose === "ocr" ? { liveModelCount: 0, returnedModelCount: models.length } : {}),
        warning: error instanceof Error ? error.message : "No se pudo refrescar desde OpenCode."
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

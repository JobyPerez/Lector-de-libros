import type { FastifyPluginAsync } from "fastify";

import { getConnection } from "../../config/database.js";
import { getUserAiCredentials } from "../../services/user-ai-credentials.js";
import { getAwsMonthToDateSpend } from "../../services/aws-cost.js";
import { authenticateRequest } from "../auth/auth.routes.js";

export const registerAwsCostRoutes: FastifyPluginAsync = async (app) => {
  app.get("/month-to-date", { preHandler: [authenticateRequest] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const connection = await getConnection();

    let credentials;
    try {
      credentials = await getUserAiCredentials(request.currentUser.userId, connection);
    } finally {
      await connection.close();
    }

    if (!credentials.hasAwsCredentials || !credentials.awsAccessKeyId || !credentials.awsSecretAccessKey) {
      return reply.status(409).send({
        message: "AWS no esta configurado. Configura tus credenciales en tu perfil para consultar el gasto."
      });
    }

    try {
      const spend = await getAwsMonthToDateSpend({
        accessKeyId: credentials.awsAccessKeyId,
        region: credentials.awsRegion ?? "us-east-1",
        secretAccessKey: credentials.awsSecretAccessKey
      });

      return reply.send(spend);
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      const message = error instanceof Error ? error.message : "No se pudo consultar el gasto de AWS.";

      if (name === "AccessDeniedException" || name === "UnrecognizedClientException" || name === "InvalidClientTokenId") {
        return reply.status(403).send({
          message:
            "Tu usuario IAM no tiene permiso para Cost Explorer (ce:GetCostAndUsage) o las credenciales no son validas. Concede ese permiso en AWS para ver el gasto."
        });
      }

      if (name === "ExpiredTokenException" || name === "RequestExpiredException") {
        return reply.status(403).send({ message: "Las credenciales de AWS estan caducadas." });
      }

      throw Object.assign(new Error(`No se pudo consultar el gasto de AWS. ${message}`.trim()), {
        statusCode: 502
      });
    }
  });
};
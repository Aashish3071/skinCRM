import { getEnv } from "@skincrm/config";
import { closeAllConnections } from "@skincrm/db";
import { buildApp } from "./app";
import { logger } from "./logger";
import { startWorker } from "./worker/loop";

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  logger.info(
    {
      port: env.API_PORT,
      env: env.NODE_ENV,
      // Surfaced at boot so nobody has to guess whether the safety switches are on.
      outboundSending: env.OUTBOUND_SENDING_ENABLED,
      conversionFeedback: env.CONVERSION_FEEDBACK_ENABLED,
      // Suffixed because the log redactor censors a bare `email` key.
      connectors: {
        emailMode: env.CONNECTOR_EMAIL,
        whatsappMode: env.CONNECTOR_WHATSAPP,
        metaMode: env.CONNECTOR_META,
        googleMode: env.CONNECTOR_GOOGLE,
      },
    },
    "API listening",
  );

  // Development convenience: one process runs the API and the worker.
  const stopWorker = env.WORKER_IN_API ? startWorker(env.WORKER_POLL_MS) : null;

  // Drain in-flight requests before dropping the database pool, so a deploy does
  // not abort a transaction mid-write.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    try {
      await app.close();
      await stopWorker?.();
      await closeAllConnections();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "Shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error({ err: error }, "Failed to start API");
  process.exit(1);
});

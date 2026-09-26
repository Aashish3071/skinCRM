import { getEnv } from "@skincrm/config";
import { closeAllConnections } from "@skincrm/db";
import { logger } from "../logger";
import { startWorker } from "./loop";

/**
 * Standalone worker process: a second entry point of the API package, so it
 * runs exactly the same services the API does (D-59).
 *
 *   dev:        pnpm --filter @skincrm/api worker
 *   production: node apps/api/dist/worker.js
 *
 * Postgres is the queue. Automation runs are rows with a `next_run_at`, and
 * this polls for due ones. That keeps an enrollment in the same transaction as
 * the event that caused it: nothing is enqueued for a lead that was rolled
 * back, and nothing is lost if a separate queue restarts.
 */
const stop = startWorker(getEnv().WORKER_POLL_MS);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Worker shutting down");
  await stop();
  await closeAllConnections();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

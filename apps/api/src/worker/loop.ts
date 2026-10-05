import { reconcileDeliveryReceipts } from "../messaging/delivery";
import { logger } from "../logger";
import { syncDueGoogleForms } from "../integrations/sync";
import { processDueInboundEvents } from "../integrations/processor";
import { processSlaBreaches } from "../leads/sla";
import { housekeeping, processDueAutomations } from "./jobs";
import { heartbeat, runMonitor } from "../ops/monitor";
import { processTimedNotifications } from "../notifications/service";
import { processFeedbackOutbox } from "../feedback/service";
import { syncDueCalendars } from "../calendar/sync";
import { syncAdvertisingForAllClinics } from "../advertising/service";

const HOUSEKEEPING_MS = 60 * 60 * 1000;
const MONITOR_MS = 5 * 60 * 1000;

/**
 * Start the polling loop. Returns a function that stops it and resolves once
 * the in-flight tick has finished, so a shutdown never cuts a run's
 * transaction in half.
 */
export function startWorker(pollMs: number): () => Promise<void> {
  let stopping = false;
  let lastHousekeeping = 0;
  let lastMonitor = 0;
  let lastTimed = 0;
  let lastAudiences = 0;
  let wake: (() => void) | null = null;

  const done = (async () => {
    logger.info({ pollMs }, "Worker started");
    while (!stopping) {
      try {
        // Drain: keep going while full batches come back.
        let processed = 0;
        let batches = 0;
        do {
          // New leads first: an automation may be waiting on them.
          processed = (await processDueInboundEvents()) + (await processDueAutomations()) + (await processSlaBreaches()) + (await processFeedbackOutbox());
          await heartbeat("worker");
        } while (processed > 0 && !stopping && ++batches < 10);
        await reconcileDeliveryReceipts();

        // Tells /health/ready and the monitor the worker is alive.
        await heartbeat("worker");
        if (Date.now() - lastTimed > 60_000) {
          lastTimed = Date.now();
          await processTimedNotifications();
          // Staff Google/Outlook calendars: each connection every few minutes (D-94).
          await syncDueCalendars();
        }
        if (Date.now() - lastMonitor > MONITOR_MS) {
          lastMonitor = Date.now();
          await runMonitor();
          await syncDueGoogleForms();
        }

        if (Date.now() - lastHousekeeping > HOUSEKEEPING_MS) {
          lastHousekeeping = Date.now();
          await housekeeping();
          // Ad spend hourly; audiences once a day (D-95).
          const audiencesDue = Date.now() - lastAudiences > 24 * HOUSEKEEPING_MS;
          if (audiencesDue) lastAudiences = Date.now();
          await syncAdvertisingForAllClinics({ audiences: audiencesDue });
        }
      } catch (error) {
        logger.error({ err: error instanceof Error ? error.message : String(error) }, "Worker tick failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    logger.info("Worker stopped");
  })();

  return async () => {
    stopping = true;
    wake?.();
    await done;
  };
}

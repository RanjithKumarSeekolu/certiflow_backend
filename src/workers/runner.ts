import { startConsumers, Consumers } from "../queues/broker";
import { Q } from "../queues/queue-names";
import { issueBatch, renderCertificate, deliverCertificate, onDeliveryExhausted } from "./handlers";
import { sweepOnce } from "./sweeper";
import { SlaMonitorWorker } from "./sla.worker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the queue consumers plus the periodic sweeper and SLA scan.
 * Reconnects by itself if the broker restarts. Resolves once the first connection is up.
 */
export async function startWorkers(): Promise<{ stop(): Promise<void> }> {
  let stopped = false;
  let current: Consumers | null = null;

  const consumeOnce = async () => {
    current = await startConsumers(
      { [Q.issue]: issueBatch, [Q.render]: renderCertificate, [Q.deliver]: deliverCertificate },
      { [Q.deliver]: onDeliveryExhausted }
    );
    return current;
  };

  const first = await consumeOnce();
  const supervise = (async () => {
    let conn: Consumers | null = first;
    while (!stopped) {
      if (conn) await new Promise((resolve) => conn!.connection.once("close", resolve));
      conn = null;
      while (!stopped && !conn) {
        await sleep(2000);
        try { conn = await consumeOnce(); } catch { /* broker still down: keep trying */ }
      }
    }
  })();

  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try { await fn(); } catch (err: any) { console.error(`[worker] ${name} failed: ${err?.message}`); }
  };
  const timers = [
    setInterval(safe("sweeper", sweepOnce), Number(process.env.SWEEP_INTERVAL_MS) || 30_000),
    setInterval(safe("sla-scan", () => SlaMonitorWorker.scanAndEscalateBreaches()), Number(process.env.SLA_SCAN_INTERVAL_MS) || 60_000),
  ];

  return {
    async stop() {
      stopped = true;
      timers.forEach(clearInterval);
      await current?.stop();
      await supervise;
    },
  };
}

import "dotenv/config";
import { jwtSecret } from "./config/env";
import { startWorkers } from "./workers/runner";

jwtSecret(); // same fail-fast config check as the API

async function main() {
  // Retry until the broker is reachable (it may still be starting).
  for (;;) {
    try {
      const workers = await startWorkers();
      console.log("CertiFlow worker running: consuming queues, sweeping, scanning SLAs");
      const shutdown = async () => {
        await workers.stop();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      return;
    } catch (err: any) {
      console.error(`[worker] cannot start (${err?.message}); retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();

import { defineConfig } from "vitest/config";

// Tests run against a throwaway local Postgres + Redis (see SETUP.md), never the .env database.
const db = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:55432/certiflow_test?schema=public";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: db,
      DIRECT_URL: db,
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:56379",
      JWT_SECRET: "test-only-secret",
      DEMO_MODE: "true",
      PUBLIC_APP_URL: "http://localhost:8081",
      RABBITMQ_URL: process.env.TEST_RABBITMQ_URL ?? "amqp://localhost:56672",
      // Fast retries, and enough attempts that a 35% failure rate never dead-letters in a 60-candidate run
      // (0.45^12 per message is negligible). Production defaults are slower and capped at 5.
      RETRY_DELAY_MS: "100",
      QUEUE_MAX_ATTEMPTS: "12",
      STALE_PROCESSING_MS: "1000",
      SWEEP_INTERVAL_MS: "1000",
      SWEEP_MIN_AGE_MS: "3000",
    },
  },
});

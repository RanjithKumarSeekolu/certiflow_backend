import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Keeps retrying with backoff, so a Redis restart is picked up again.
// Commands fail fast while disconnected (no offline queue) instead of hanging requests.
export const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});
redis.on("error", () => {}); // connection errors are handled by callers / retry strategy
redis.connect().catch(() => {});

/**
 * Fixed-window rate limit shared across instances.
 * Fails OPEN if Redis is down: public verification must stay available.
 */
export async function allowRequest(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count <= limit;
  } catch {
    return true;
  }
}

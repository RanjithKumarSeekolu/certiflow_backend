import Redis from "ioredis";
import prisma from "../config/db";
import { redis } from "../config/redis";
import { broadcastEvent } from "./socket";

/**
 * Cross-process realtime: any process (API or worker) publishes to Redis,
 * every API instance forwards to its own Socket.IO clients. No PII in payloads.
 */
const CHANNEL = "certiflow:events";

export interface AppEvent {
  type: string;
  rooms: string[];
  batchId?: string;
  certificateId?: string;
  status?: string;
  at?: string;
}

export async function emitEvent(event: AppEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify({ ...event, at: new Date().toISOString() }));
  } catch {
    // Realtime is best-effort; clients can always refetch.
  }
}

/** Tells everyone who can see this batch (its centre, its district, quality team, state office). */
export async function emitBatchEvent(batchId: string, type: string): Promise<void> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: { centre: true } });
  if (!batch) return;
  const rooms = [`district:${batch.centre.districtId}`, "role:STATE_OFFICE", "role:QUALITY_TEAM"];
  if (batch.centre.userId) rooms.push(`user:${batch.centre.userId}`);
  await emitEvent({ type, batchId, status: batch.status, rooms });
}

/** API side: forward Redis events to this instance's sockets. */
export function startEventForwarder(): Redis {
  const sub = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  sub.on("error", () => {});
  sub.subscribe(CHANNEL).catch(() => {});
  sub.on("message", (_channel, raw) => {
    try {
      const { rooms, ...payload } = JSON.parse(raw) as AppEvent;
      for (const room of rooms) broadcastEvent(payload.type, payload, room);
    } catch {
      // ignore malformed messages
    }
  });
  return sub;
}

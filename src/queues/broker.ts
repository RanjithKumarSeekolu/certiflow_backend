import amqp from "amqplib";
import { Q, QueueName, retryQueue, deadQueue } from "./queue-names";

const url = () => process.env.RABBITMQ_URL || "amqp://localhost:5672";
const retryDelayMs = () => Number(process.env.RETRY_DELAY_MS) || 5000;
export const maxAttempts = () => Number(process.env.QUEUE_MAX_ATTEMPTS) || 5;
const prefetch = () => Number(process.env.QUEUE_PREFETCH) || 10;

/** Handlers throw to request a retry. Throw DeferError to retry later WITHOUT using up an attempt. */
export class DeferError extends Error {}

export type Handler = (payload: any) => Promise<void>;

async function assertTopology(ch: amqp.Channel): Promise<void> {
  for (const q of Object.values(Q)) {
    await ch.assertQueue(q, { durable: true });
    await ch.assertQueue(deadQueue(q), { durable: true });
    // Retry queue: messages expire after a per-message delay and dead-letter back to the main queue.
    await ch.assertQueue(retryQueue(q), {
      durable: true,
      arguments: { "x-dead-letter-exchange": "", "x-dead-letter-routing-key": q },
    });
  }
}

function send(ch: amqp.ConfirmChannel, queue: string, payload: object, options: amqp.Options.Publish = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    ch.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true, ...options }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

// ---- Publishing (used by the API and by handlers) ----------------------------------------------

let publisher: Promise<amqp.ConfirmChannel> | null = null;
let publisherConn: amqp.ChannelModel | null = null;

async function publisherChannel(): Promise<amqp.ConfirmChannel> {
  if (!publisher) {
    publisher = (async () => {
      const conn = await amqp.connect(url());
      publisherConn = conn;
      const reset = () => { publisher = null; };
      conn.on("close", reset);
      conn.on("error", reset);
      const ch = await conn.createConfirmChannel();
      ch.on("error", reset);
      await assertTopology(ch);
      return ch;
    })();
    publisher.catch(() => { publisher = null; }); // next call reconnects
  }
  return publisher;
}

/** Durable publish: resolves only after the broker confirms. Throws if the broker is down. */
export async function publish(queue: QueueName, payload: object): Promise<void> {
  await send(await publisherChannel(), queue, payload);
}

export async function closePublisher(): Promise<void> {
  publisher = null;
  await publisherConn?.close().catch(() => {});
  publisherConn = null;
}

export async function purgeAll(): Promise<void> {
  const ch = await publisherChannel();
  for (const q of Object.values(Q)) {
    for (const name of [q, retryQueue(q), deadQueue(q)]) await ch.purgeQueue(name);
  }
}

export async function deadLetterCount(queue: QueueName): Promise<number> {
  return (await (await publisherChannel()).checkQueue(deadQueue(queue))).messageCount;
}

// ---- Consuming ---------------------------------------------------------------------------------

export interface Consumers {
  connection: amqp.ChannelModel;
  stop(): Promise<void>;
}

/**
 * Consume every pipeline queue with retry + dead-letter. A message is acked only after the handler
 * succeeded (or after it was safely moved to the retry/dead queue), so a crash redelivers it.
 */
export async function startConsumers(
  handlers: Record<QueueName, Handler>,
  onExhausted: Partial<Record<QueueName, (payload: any, err: Error) => Promise<void>>> = {}
): Promise<Consumers> {
  const connection = await amqp.connect(url());
  connection.on("error", () => {}); // 'close' is handled by the supervisor
  const ch = await connection.createConfirmChannel();
  ch.on("error", () => {});
  await assertTopology(ch);
  await ch.prefetch(prefetch());

  for (const q of Object.values(Q)) {
    await ch.consume(q, async (msg) => {
      if (!msg) return;
      const payload = JSON.parse(msg.content.toString());
      const attempts = Number(msg.properties.headers?.["x-attempts"] ?? 0);
      try {
        await handlers[q](payload);
        ch.ack(msg);
      } catch (err: any) {
        try {
          const next = err instanceof DeferError ? attempts : attempts + 1;
          if (next >= maxAttempts()) {
            await onExhausted[q]?.(payload, err);
            await send(ch, deadQueue(q), payload, { headers: { "x-attempts": next, "x-error": String(err?.message) } });
          } else {
            await send(ch, retryQueue(q), payload, { headers: { "x-attempts": next }, expiration: String(retryDelayMs()) });
          }
          ch.ack(msg);
        } catch {
          // Channel closed or broker unavailable mid-failure: leave it unacked so it is redelivered.
        }
      }
    });
  }

  return { connection, stop: () => connection.close().catch(() => {}) as Promise<void> };
}

// Pipeline: batch.issue -> certificate.render (PDF) -> certificate.deliver (WhatsApp)
export const Q = {
  issue: "batch.issue",
  render: "certificate.render",
  deliver: "certificate.deliver",
} as const;

export type QueueName = (typeof Q)[keyof typeof Q];

export const retryQueue = (q: QueueName) => `${q}.retry`; // waits RETRY_DELAY_MS, then returns to q
export const deadQueue = (q: QueueName) => `${q}.dlq`; // gave up after QUEUE_MAX_ATTEMPTS

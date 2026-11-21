/**
 * Stand-in WhatsApp provider. Behaves like a flaky real one:
 *  - fails before delivering (network error, rate limit)  -> `failureRate`
 *  - times out AFTER delivering (the nasty case that causes duplicate sends) -> `timeoutAfterDeliveryRate`
 * It honours an idempotency key (a retry with the same key never delivers twice), like a provider
 * that supports one. One call = one attempt; retries are the queue's job.
 */
export interface WhatsAppSendMessagePayload {
  to: string;
  templateName: string;
  parameters: {
    candidateName: string;
    courseName: string;
    certificateNumber: string;
    downloadUrl: string;
  };
  idempotencyKey: string;
}

export interface WhatsAppDeliveryResult {
  success: boolean;
  messageId: string;
  recipient: string;
  timestamp: string;
}

export class StandinWhatsAppProvider {
  private static delivered = new Map<string, WhatsAppDeliveryResult>();
  private static sends = new Map<string, number>(); // real deliveries per key; must never exceed 1

  public static failureRate = 0.35;
  public static timeoutAfterDeliveryRate = 0.1;

  public static reset(): void {
    this.delivered.clear();
    this.sends.clear();
  }

  public static getDeliveredKeys(): Map<string, WhatsAppDeliveryResult> {
    return this.delivered;
  }

  /** How many times this key was actually delivered to the "phone". */
  public static getSendCounts(): Map<string, number> {
    return this.sends;
  }

  public static async sendMessage(payload: WhatsAppSendMessagePayload): Promise<WhatsAppDeliveryResult> {
    const already = this.delivered.get(payload.idempotencyKey);
    if (already) return already;

    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15)); // latency

    if (Math.random() < this.failureRate) {
      const errors = [
        "CONNECTION_RESET_BY_PEER: socket closed unexpectedly",
        "RATE_LIMIT_EXCEEDED: upstream provider throttled request",
        "TEMPORARY_NETWORK_FAILURE: DNS resolution timeout",
      ];
      throw new Error(errors[Math.floor(Math.random() * errors.length)]!);
    }

    const result: WhatsAppDeliveryResult = {
      success: true,
      messageId: `wa_msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      recipient: payload.to,
      timestamp: new Date().toISOString(),
    };
    this.delivered.set(payload.idempotencyKey, result);
    this.sends.set(payload.idempotencyKey, (this.sends.get(payload.idempotencyKey) ?? 0) + 1);

    if (Math.random() < this.timeoutAfterDeliveryRate) {
      throw new Error("GATEWAY_TIMEOUT: no response in 5000ms (message may have been delivered)");
    }
    return result;
  }
}

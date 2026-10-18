/**
 * WebhookRetryService — persistent webhook delivery with exponential backoff.
 *
 * Implements the retry schedule defined in docs/WEBHOOK_RETRY.md:
 *   Attempt 1 → 1 s
 *   Attempt 2 → 2 s
 *   Attempt 3 → 4 s
 *   Attempt 4 → 8 s
 *   Attempt 5 → 16 s
 *   Attempt 6+ → permanent failure
 *
 * Closes #1071
 */

import { randomUUID } from "crypto";

export interface WebhookDeliveryAttempt {
  attemptNumber: number;
  attemptedAt: Date;
  status: "success" | "failed";
  error: string | null;
  nextRetryAt: Date | null;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  url: string;
  payload: object;
  attemptNumber: number;
  maxAttempts: number;
  status: "pending" | "success" | "failed" | "permanent_failure";
  lastError: string | null;
  nextRetryAt: Date | null;
  attempts: WebhookDeliveryAttempt[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookRetryServiceOptions {
  /** Maximum number of delivery attempts (default: 5). */
  maxAttempts?: number;
  /** Base delay in milliseconds for the exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 16000). */
  maxDelayMs?: number;
}

/**
 * In-memory delivery store (use a real DB adapter in production).
 * The in-memory store is reset between test runs via `__resetForTests`.
 */
const inMemoryStore = new Map<string, WebhookDelivery>();

export class WebhookRetryService {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: WebhookRetryServiceOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 16_000;
  }

  /**
   * Calculate the exponential backoff delay for a given attempt number.
   *
   * Formula: `min(maxDelayMs, baseDelayMs * 2^(attemptNumber - 1))`
   *
   * @param attemptNumber - 1-based attempt counter.
   * @returns Delay in milliseconds, capped at {@link maxDelayMs}.
   */
  calculateBackoff(attemptNumber: number): number {
    const delay = this.baseDelayMs * Math.pow(2, attemptNumber - 1);
    return Math.min(this.maxDelayMs, delay);
  }

  /**
   * Schedule a webhook delivery for the given attempt.
   *
   * Creates a delivery record in the store with status `pending` and a
   * `nextRetryAt` timestamp computed from the backoff for this attempt.
   *
   * @param webhookId - ID of the registered webhook.
   * @param url - Destination URL.
   * @param payload - Event payload object.
   * @param attemptNumber - Which attempt this is (1-based).
   * @returns The newly created {@link WebhookDelivery} record.
   */
  async scheduleRetry(
    webhookId: string,
    url: string,
    payload: object,
    attemptNumber: number
  ): Promise<WebhookDelivery> {
    const now = new Date();
    const backoffMs = this.calculateBackoff(attemptNumber);
    const nextRetryAt = new Date(now.getTime() + backoffMs);

    const delivery: WebhookDelivery = {
      id: randomUUID(),
      webhookId,
      url,
      payload,
      attemptNumber,
      maxAttempts: this.maxAttempts,
      status: "pending",
      lastError: null,
      nextRetryAt,
      attempts: [],
      createdAt: now,
      updatedAt: now,
    };

    inMemoryStore.set(delivery.id, delivery);
    return delivery;
  }

  /**
   * Enqueue a failed webhook delivery for automatic retry.
   *
   * Convenience entry point used by callers when a delivery fails: it
   * schedules the first retry attempt (attempt 1 → 1 s backoff) and records
   * the originating error so the retry history is complete.
   *
   * @param webhookId - ID of the registered webhook.
   * @param url - Destination URL.
   * @param payload - Event payload object.
   * @param error - The error that caused the initial delivery to fail.
   * @returns The newly created {@link WebhookDelivery} record.
   */
  async enqueueFailedDelivery(
    webhookId: string,
    url: string,
    payload: object,
    error: string | null = null
  ): Promise<WebhookDelivery> {
    const delivery = await this.scheduleRetry(webhookId, url, payload, 1);
    delivery.lastError = error;
    inMemoryStore.set(delivery.id, delivery);
    return delivery;
  }

  /**
   * Process a pending delivery by attempting an HTTP POST to its URL.
   *
   * - On success (2xx): marks the record `success`.
   * - On failure (non-2xx or network error):
   *   - If `attemptNumber < maxAttempts`: bumps attempt counter, updates
   *     `nextRetryAt` with the next backoff window, keeps status `pending`.
   *   - If `attemptNumber >= maxAttempts`: marks the record `failed`.
   *
   * Every attempt is appended to `attempts` so the delivery history exposes
   * the full retry trail.
   *
   * @param deliveryId - ID of the delivery record to process.
   * @returns The updated {@link WebhookDelivery} record.
   * @throws Error if the delivery is not found.
   */
  async processDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = inMemoryStore.get(deliveryId);
    if (!delivery) {
      throw new Error(`Delivery ${deliveryId} not found`);
    }

    const now = new Date();
    delivery.updatedAt = now;

    let succeeded = false;

    try {
      const response = await fetch(delivery.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delivery.payload),
      });

      if (response.ok) {
        succeeded = true;
        delivery.status = "success";
        delivery.lastError = null;
        delivery.nextRetryAt = null;
      } else {
        // Non-2xx response counts as failure
        delivery.lastError = `HTTP ${response.status}: ${response.statusText}`;
      }
    } catch (err: unknown) {
      delivery.lastError = err instanceof Error ? err.message : String(err);
    }

    if (succeeded) {
      delivery.attempts.push({
        attemptNumber: delivery.attemptNumber,
        attemptedAt: now,
        status: "success",
        error: null,
        nextRetryAt: null,
      });
      inMemoryStore.set(deliveryId, delivery);
      return delivery;
    }

    // Delivery failed — check whether we can retry
    if (delivery.attemptNumber < this.maxAttempts) {
      const nextAttempt = delivery.attemptNumber + 1;
      const nextRetryAt = new Date(now.getTime() + this.calculateBackoff(nextAttempt));
      delivery.attempts.push({
        attemptNumber: delivery.attemptNumber,
        attemptedAt: now,
        status: "failed",
        error: delivery.lastError,
        nextRetryAt,
      });
      delivery.attemptNumber = nextAttempt;
      delivery.status = "pending";
      delivery.nextRetryAt = nextRetryAt;
    } else {
      delivery.attempts.push({
        attemptNumber: delivery.attemptNumber,
        attemptedAt: now,
        status: "failed",
        error: delivery.lastError,
        nextRetryAt: null,
      });
      delivery.status = "failed";
      delivery.nextRetryAt = null;
    }

    inMemoryStore.set(deliveryId, delivery);
    return delivery;
  }

  /**
   * Retrieve the delivery history for a specific webhook.
   *
   * Each record includes its `attempts` array so callers (e.g. the
   * `GET /api/v1/webhooks/:id/deliveries` endpoint) can surface the full
   * retry history.
   *
   * @param webhookId - ID of the webhook to look up.
   * @returns Array of {@link WebhookDelivery} records ordered by creation time (newest first).
   */
  async getDeliveryHistory(webhookId: string): Promise<WebhookDelivery[]> {
    return Array.from(inMemoryStore.values())
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Retrieve all pending deliveries whose `nextRetryAt` time has passed.
   *
   * Useful for a background worker that polls for overdue retries.
   *
   * @returns Array of overdue pending {@link WebhookDelivery} records.
   */
  async getPendingRetries(): Promise<WebhookDelivery[]> {
    const now = new Date();
    return Array.from(inMemoryStore.values()).filter(
      (d) => d.status === "pending" && d.nextRetryAt !== null && d.nextRetryAt <= now
    );
  }

  /**
   * Reset the in-memory store — **only for use in unit tests**.
   */
  __resetForTests(): void {
    inMemoryStore.clear();
  }
}

/** Default singleton instance. */
export const webhookRetryService = new WebhookRetryService();

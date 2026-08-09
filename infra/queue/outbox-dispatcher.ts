import type {
  ClockPort,
  JobEnvelope,
  QueueMetricEvent,
  QueueObservabilityPort,
} from "../../packages/platform/src/contracts.js";
import {
  defaultRetryPolicy,
  idempotencyKey,
  jobId,
  nextRetryDelayMs,
  shouldRetry,
  validateSafePayload,
  type RetryPolicy,
} from "../../packages/platform/src/contracts.js";
import type { OutboxRecord } from "../postgres/repositories.js";
import type { QueuePublisher } from "./redis-queue.js";

export interface OutboxDispatcherConfig {
  readonly batchSize: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface OutboxStore {
  claimDue(limit: number, now: Date): Promise<readonly OutboxRecord[]>;
  markManualReview(id: string, classification: string): Promise<void>;
  markPublished(id: string, publishedAt: Date): Promise<void>;
  scheduleRetry(
    id: string,
    retryCount: number,
    nextAttemptAt: Date,
    classification: string,
  ): Promise<void>;
}

const toJob = (
  record: OutboxRecord,
  retryPolicy: RetryPolicy,
): JobEnvelope => ({
  attempt: {
    attempt: record.retryCount + 1,
    maxAttempts: retryPolicy.maxAttempts,
  },
  correlationId: record.correlationId,
  createdAt: new Date(),
  entityReferenceId: record.aggregateId,
  idempotencyKey: idempotencyKey(record.eventDeduplicationKey),
  jobId: jobId(record.id),
  jobType: record.eventType,
  payload: validateSafePayload(record.payload),
  schemaVersion: 1,
});

export class OutboxDispatcher {
  private readonly retryPolicy: RetryPolicy;

  public constructor(
    private readonly outbox: OutboxStore,
    private readonly publisher: QueuePublisher,
    private readonly clock: ClockPort,
    private readonly observability: QueueObservabilityPort,
    config: OutboxDispatcherConfig,
  ) {
    this.retryPolicy = config.retryPolicy ?? defaultRetryPolicy;
    this.batchSize = config.batchSize;
  }

  private readonly batchSize: number;

  public async dispatchDue(): Promise<number> {
    const now = this.clock.now();
    const records = await this.outbox.claimDue(this.batchSize, now);
    if (records[0]) {
      await this.emit({
        correlationId: records[0].correlationId,
        count: records.length,
        occurredAt: now,
        type: "OUTBOX_BACKLOG",
      });
    }

    let published = 0;
    for (const record of records) {
      try {
        await this.publisher.publish(toJob(record, this.retryPolicy));
        await this.outbox.markPublished(record.id, this.clock.now());
        published += 1;
        await this.emit({
          correlationId: record.correlationId,
          occurredAt: this.clock.now(),
          type: "JOB_QUEUED",
        });
      } catch (error) {
        const nextRetryCount = record.retryCount + 1;
        if (shouldRetry(nextRetryCount, "RETRYABLE", this.retryPolicy)) {
          const delay = nextRetryDelayMs(nextRetryCount, this.retryPolicy);
          await this.outbox.scheduleRetry(
            record.id,
            nextRetryCount,
            new Date(this.clock.now().getTime() + delay),
            "RETRYABLE_PUBLICATION_FAILURE",
          );
          await this.emit({
            correlationId: record.correlationId,
            occurredAt: this.clock.now(),
            type: "JOB_RETRY_SCHEDULED",
          });
        } else {
          await this.outbox.markManualReview(
            record.id,
            error instanceof Error ? error.name : "UNKNOWN_PUBLICATION_FAILURE",
          );
          await this.emit({
            correlationId: record.correlationId,
            occurredAt: this.clock.now(),
            type: "JOB_RETRIES_EXHAUSTED",
          });
        }
      }
    }

    return published;
  }

  private async emit(event: QueueMetricEvent): Promise<void> {
    await this.observability.emit(event);
  }
}

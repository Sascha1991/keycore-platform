import type { CorrelationId } from "../contracts.js";

export type QueueMetricEventType =
  | "JOB_QUEUED"
  | "JOB_COMPLETED"
  | "JOB_FAILED"
  | "JOB_RETRY_SCHEDULED"
  | "JOB_RETRIES_EXHAUSTED"
  | "RECONCILIATION_CREATED"
  | "RECONCILIATION_COMPLETED"
  | "RECONCILIATION_ESCALATED"
  | "OUTBOX_BACKLOG";

export interface QueueMetricEvent {
  readonly type: QueueMetricEventType;
  readonly correlationId: CorrelationId;
  readonly count?: number;
  readonly occurredAt: Date;
  readonly safeMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface QueueObservabilityPort {
  emit(event: QueueMetricEvent): void | Promise<void>;
}

export class InMemoryQueueObservability implements QueueObservabilityPort {
  public readonly events: QueueMetricEvent[] = [];

  public emit(event: QueueMetricEvent): void {
    this.events.push(event);
  }
}

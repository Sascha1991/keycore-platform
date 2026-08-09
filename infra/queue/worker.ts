import type {
  JobEnvelope,
  QueueMetricEvent,
  QueueObservabilityPort,
} from "../../packages/platform/src/contracts.js";
import { classifyError } from "../../packages/platform/src/contracts.js";

export type WorkerHealthState =
  "STARTING" | "HEALTHY" | "STOPPING" | "STOPPED" | "DEGRADED";

export interface JobHandlerContext {
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type JobHandler = (
  job: JobEnvelope,
  context: JobHandlerContext,
) => Promise<void>;

export interface WorkerQueue {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  take(): Promise<JobEnvelope | null>;
}

export class WorkerLifecycle {
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private healthState: WorkerHealthState = "STOPPED";

  public constructor(
    private readonly queue: WorkerQueue,
    private readonly observability: QueueObservabilityPort,
  ) {}

  public get health(): WorkerHealthState {
    return this.healthState;
  }

  public register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  public async start(): Promise<void> {
    this.healthState = "STARTING";
    await this.queue.connect();
    this.running = true;
    this.healthState = "HEALTHY";
  }

  public async stop(): Promise<void> {
    this.healthState = "STOPPING";
    this.running = false;
    await this.queue.disconnect();
    this.healthState = "STOPPED";
  }

  public async processOne(): Promise<boolean> {
    if (!this.running) {
      return false;
    }

    const job = await this.queue.take();
    if (!job) {
      return false;
    }

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      this.healthState = "DEGRADED";
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        type: "JOB_FAILED",
      });
      return false;
    }

    try {
      await handler(job, {
        correlationId: job.correlationId,
        idempotencyKey: job.idempotencyKey,
      });
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        type: "JOB_COMPLETED",
      });
      return true;
    } catch (error) {
      const classification = classifyError(error);
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        safeMetadata: { classification },
        type: "JOB_FAILED",
      });
      return false;
    }
  }

  private async emit(event: QueueMetricEvent): Promise<void> {
    await this.observability.emit(event);
  }
}

import type {
  JobEnvelope,
  QueueMetricEvent,
  QueueObservabilityPort,
} from "../../packages/platform/src/contracts.js";
import { classifyError } from "../../packages/platform/src/contracts.js";
import type { ReservedJob } from "./redis-queue.js";

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
  acknowledge(reservation: ReservedJob): Promise<void>;
  fail(reservation: ReservedJob): Promise<void>;
  reserve(): Promise<ReservedJob | null>;
}

export class WorkerLifecycle {
  private readonly handlers = new Map<string, JobHandler>();
  private activeHandlers = 0;
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
    while (this.activeHandlers > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.queue.disconnect();
    this.healthState = "STOPPED";
  }

  public async processOne(): Promise<boolean> {
    if (!this.running) {
      return false;
    }

    const reservation = await this.queue.reserve();
    if (!reservation) {
      return false;
    }
    const { job } = reservation;

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      this.healthState = "DEGRADED";
      await this.queue.fail(reservation);
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        type: "JOB_FAILED",
      });
      return false;
    }

    try {
      this.activeHandlers += 1;
      await handler(job, {
        correlationId: job.correlationId,
        idempotencyKey: job.idempotencyKey,
      });
      await this.queue.acknowledge(reservation);
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        type: "JOB_COMPLETED",
      });
      return true;
    } catch (error) {
      const classification = classifyError(error);
      await this.queue.fail(reservation);
      await this.emit({
        correlationId: job.correlationId,
        occurredAt: new Date(),
        safeMetadata: { classification },
        type: "JOB_FAILED",
      });
      return false;
    } finally {
      this.activeHandlers -= 1;
    }
  }

  private async emit(event: QueueMetricEvent): Promise<void> {
    await this.observability.emit(event);
  }
}

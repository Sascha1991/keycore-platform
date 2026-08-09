import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  correlationId,
  defaultRetryPolicy,
  idempotencyKey,
  InMemoryQueueObservability,
  jobId,
  nextRetryDelayMs,
  redactForLog,
  validateSafePayload,
  type ClockPort,
  type JobEnvelope,
  type QueueObservabilityPort,
} from "../../packages/platform/src/contracts.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import type { QueuePublisher, ReservedJob } from "./redis-queue.js";
import { WorkerLifecycle } from "./worker.js";

const syntheticJob = (): JobEnvelope => ({
  attempt: {
    attempt: 1,
    maxAttempts: 3,
  },
  correlationId: correlationId(`corr-${randomUUID()}`),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  idempotencyKey: idempotencyKey(`idem-${randomUUID()}`),
  jobId: jobId(`job-${randomUUID()}`),
  jobType: "synthetic.test",
  payload: {
    referenceId: "entity-1",
  },
  schemaVersion: 1,
});

describe("safe queue payloads", () => {
  it("rejects forbidden top-level queue payload fields", () => {
    expect(() =>
      validateSafePayload({
        productKey: "forbidden",
      }),
    ).toThrow("Forbidden queue payload field");
  });

  it("rejects forbidden nested sensitive fields", () => {
    expect(() =>
      validateSafePayload({
        nested: {
          credentials: {
            apiSecret: "forbidden",
          },
        },
      }),
    ).toThrow("Forbidden queue payload field");
  });

  it("redacts payloads for logging instead of logging full payloads", () => {
    expect(
      redactForLog({
        referenceId: "safe-reference",
      }),
    ).toEqual({ fieldCount: 1 });
  });
});

describe("retry policy", () => {
  it("uses capped exponential backoff with deterministic jitter", () => {
    expect(
      nextRetryDelayMs(1, {
        baseDelayMs: 100,
        jitterRatio: 0.1,
        maxAttempts: 4,
        maxDelayMs: 1_000,
      }),
    ).toBe(110);
    expect(
      nextRetryDelayMs(4, {
        baseDelayMs: 100,
        jitterRatio: 0.1,
        maxAttempts: 4,
        maxDelayMs: 500,
      }),
    ).toBe(500);
  });

  it("does not retry forever", () => {
    expect(defaultRetryPolicy.maxAttempts).toBeGreaterThan(0);
  });
});

describe("outbox dispatcher", () => {
  it("publishes claimed outbox records and marks them published", async () => {
    const clock: ClockPort = {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    const record = {
      aggregateId: randomUUID(),
      aggregateType: "synthetic",
      correlationId: correlationId("corr-1"),
      eventDeduplicationKey: "dedupe-1",
      eventType: "synthetic.event",
      id: randomUUID(),
      lastErrorClassification: null,
      nextAttemptAt: clock.now(),
      payload: { referenceId: "entity-1" },
      retryCount: 0,
      status: "PENDING" as const,
    };
    const outbox = {
      claimDue: vi.fn().mockResolvedValue([record]),
      markManualReview: vi.fn(),
      markPublished: vi.fn(),
      scheduleRetry: vi.fn(),
    };
    const publisher: QueuePublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const observability = new InMemoryQueueObservability();
    const dispatcher = new OutboxDispatcher(
      outbox,
      publisher,
      clock,
      observability,
      { batchSize: 10 },
    );

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "corr-1",
        idempotencyKey: "dedupe-1",
        jobType: "synthetic.event",
      }),
    );
    expect(outbox.markPublished).toHaveBeenCalledWith(record.id, clock.now());
  });

  it("schedules retry when Redis publication fails retryably", async () => {
    const clock: ClockPort = {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    const record = {
      aggregateId: randomUUID(),
      aggregateType: "synthetic",
      correlationId: correlationId("corr-2"),
      eventDeduplicationKey: "dedupe-2",
      eventType: "synthetic.event",
      id: randomUUID(),
      lastErrorClassification: null,
      nextAttemptAt: clock.now(),
      payload: { referenceId: "entity-2" },
      retryCount: 0,
      status: "PENDING" as const,
    };
    const outbox = {
      claimDue: vi.fn().mockResolvedValue([record]),
      markManualReview: vi.fn(),
      markPublished: vi.fn(),
      scheduleRetry: vi.fn(),
    };
    const publisher: QueuePublisher = {
      publish: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    const dispatcher = new OutboxDispatcher(
      outbox,
      publisher,
      clock,
      new InMemoryQueueObservability(),
      {
        batchSize: 10,
        retryPolicy: {
          baseDelayMs: 100,
          jitterRatio: 0,
          maxAttempts: 3,
          maxDelayMs: 1_000,
        },
      },
    );

    await expect(dispatcher.dispatchDue()).resolves.toBe(0);
    expect(outbox.scheduleRetry).toHaveBeenCalledWith(
      record.id,
      1,
      new Date("2026-01-01T00:00:00.100Z"),
      "RETRYABLE_PUBLICATION_FAILURE",
    );
  });

  it("escalates exhausted publication failures to manual review", async () => {
    const clock: ClockPort = {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    const record = {
      aggregateId: randomUUID(),
      aggregateType: "synthetic",
      correlationId: correlationId("corr-3"),
      eventDeduplicationKey: "dedupe-3",
      eventType: "synthetic.event",
      id: randomUUID(),
      lastErrorClassification: null,
      nextAttemptAt: clock.now(),
      payload: { referenceId: "entity-3" },
      retryCount: 2,
      status: "FAILED" as const,
    };
    const outbox = {
      claimDue: vi.fn().mockResolvedValue([record]),
      markManualReview: vi.fn(),
      markPublished: vi.fn(),
      scheduleRetry: vi.fn(),
    };
    const publisher: QueuePublisher = {
      publish: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    const dispatcher = new OutboxDispatcher(
      outbox,
      publisher,
      clock,
      new InMemoryQueueObservability(),
      {
        batchSize: 10,
        retryPolicy: {
          baseDelayMs: 100,
          jitterRatio: 0,
          maxAttempts: 3,
          maxDelayMs: 1_000,
        },
      },
    );

    await dispatcher.dispatchDue();
    expect(outbox.markManualReview).toHaveBeenCalledWith(record.id, "Error");
  });
});

describe("worker lifecycle", () => {
  const reserveJob = (job = syntheticJob()): ReservedJob => ({
    job,
    reservationToken: `reservation-${randomUUID()}`,
  });

  it("supports startup, handler registration, correlation propagation, and graceful shutdown", async () => {
    const reservation = reserveJob();
    const { job } = reservation;
    const queue = {
      acknowledge: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      reserve: vi.fn().mockResolvedValue(reservation),
    };
    const observability: QueueObservabilityPort =
      new InMemoryQueueObservability();
    const worker = new WorkerLifecycle(queue, observability);
    const handler = vi.fn().mockResolvedValue(undefined);

    worker.register(job.jobType, handler);
    await worker.start();
    await expect(worker.processOne()).resolves.toBe(true);
    await worker.stop();

    expect(handler).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        correlationId: job.correlationId,
        idempotencyKey: job.idempotencyKey,
      }),
    );
    expect(queue.acknowledge).toHaveBeenCalledWith(reservation);
    expect(queue.fail).not.toHaveBeenCalled();
    expect(worker.health).toBe("STOPPED");
  });

  it("requeues reserved work when the handler fails", async () => {
    const reservation = reserveJob();
    const queue = {
      acknowledge: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      reserve: vi.fn().mockResolvedValue(reservation),
    };
    const worker = new WorkerLifecycle(queue, new InMemoryQueueObservability());
    worker.register(
      reservation.job.jobType,
      vi.fn().mockRejectedValue(new Error("transient")),
    );

    await worker.start();
    await expect(worker.processOne()).resolves.toBe(false);
    await worker.stop();

    expect(queue.acknowledge).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(reservation);
  });

  it("keeps idempotency context stable across redelivery", async () => {
    const job = syntheticJob();
    const firstReservation = reserveJob(job);
    const secondReservation = reserveJob(job);
    const queue = {
      acknowledge: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      reserve: vi
        .fn()
        .mockResolvedValueOnce(firstReservation)
        .mockResolvedValueOnce(secondReservation),
    };
    const worker = new WorkerLifecycle(queue, new InMemoryQueueObservability());
    const handler = vi.fn().mockResolvedValue(undefined);
    worker.register(job.jobType, handler);

    await worker.start();
    await worker.processOne();
    await worker.processOne();
    await worker.stop();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      2,
      secondReservation.job,
      expect.objectContaining({
        idempotencyKey: firstReservation.job.idempotencyKey,
      }),
    );
  });

  it("waits for in-flight work during graceful shutdown before acknowledging", async () => {
    const reservation = reserveJob();
    let releaseHandler: (() => void) | undefined;
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerCompleted = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const queue = {
      acknowledge: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      reserve: vi.fn().mockResolvedValue(reservation),
    };
    const worker = new WorkerLifecycle(queue, new InMemoryQueueObservability());
    worker.register(reservation.job.jobType, async () => {
      markHandlerStarted?.();
      return handlerCompleted;
    });

    await worker.start();
    const processing = worker.processOne();
    await handlerStarted;
    const stopping = worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queue.disconnect).not.toHaveBeenCalled();
    releaseHandler?.();
    await processing;
    await stopping;

    expect(queue.acknowledge).toHaveBeenCalledWith(reservation);
    expect(queue.disconnect).toHaveBeenCalled();
  });
});

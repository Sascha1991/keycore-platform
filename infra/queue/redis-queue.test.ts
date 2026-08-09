import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  correlationId,
  idempotencyKey,
  jobId,
  type JobEnvelope,
} from "../../packages/platform/src/contracts.js";
import { RedisQueueAdapter } from "./redis-queue.js";

const redisUrl = process.env.KEYCORE_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const queueName = `ks-queue-${randomUUID()}`;
const processingQueueName = `${queueName}:processing`;

const makeJob = (): JobEnvelope => ({
  attempt: {
    attempt: 1,
    maxAttempts: 3,
  },
  correlationId: correlationId(`corr-${randomUUID()}`),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  idempotencyKey: idempotencyKey(`idem-${randomUUID()}`),
  jobId: jobId(`job-${randomUUID()}`),
  jobType: "synthetic.redis",
  payload: {
    referenceId: "entity-1",
  },
  schemaVersion: 1,
});

describeRedis("Redis queue adapter", () => {
  const cleanupClient = redisUrl ? createClient({ url: redisUrl }) : undefined;

  beforeAll(async () => {
    await cleanupClient?.connect();
  });

  afterAll(async () => {
    await cleanupClient?.del(queueName);
    await cleanupClient?.del(processingQueueName);
    await cleanupClient?.quit();
  });

  it("reserves and acknowledges a safe job envelope", async () => {
    if (!redisUrl) {
      throw new Error("Redis URL unavailable");
    }

    const adapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await adapter.connect();

    const job = makeJob();
    await adapter.publish(job);
    const reserved = await adapter.reserve(
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(reserved?.job).toEqual(
      expect.objectContaining({
        idempotencyKey: job.idempotencyKey,
        jobType: job.jobType,
      }),
    );
    if (!reserved) {
      throw new Error("Expected Redis reservation");
    }
    await adapter.acknowledge(reserved);
    await expect(
      cleanupClient?.sendCommand(["ZCARD", processingQueueName]),
    ).resolves.toBe(0);
    await adapter.disconnect();
  });

  it("requeues failed reserved work without losing it", async () => {
    if (!redisUrl) {
      throw new Error("Redis URL unavailable");
    }

    const adapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await adapter.connect();

    const job = makeJob();
    await adapter.publish(job);
    const firstReservation = await adapter.reserve(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    if (!firstReservation) {
      throw new Error("Expected initial Redis reservation");
    }

    await adapter.fail(firstReservation);
    const redelivered = await adapter.reserve(
      new Date("2026-01-01T00:00:01.000Z"),
    );

    expect(redelivered?.job.idempotencyKey).toBe(job.idempotencyKey);
    expect(redelivered?.reservationToken).toBe(
      firstReservation?.reservationToken,
    );
    if (!redelivered) {
      throw new Error("Expected redelivered Redis reservation");
    }
    await adapter.acknowledge(redelivered);
    await adapter.disconnect();
  });

  it("recovers stale in-flight work after a simulated worker crash", async () => {
    if (!redisUrl) {
      throw new Error("Redis URL unavailable");
    }

    const adapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await adapter.connect();

    const job = makeJob();
    await adapter.publish(job);
    const crashedReservation = await adapter.reserve(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    if (!crashedReservation) {
      throw new Error("Expected crashed Redis reservation");
    }
    await adapter.disconnect();

    const recoveringAdapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await recoveringAdapter.connect();
    const recovered = await recoveringAdapter.recoverStale(
      new Date("2026-01-01T00:00:01.000Z"),
    );
    const redelivered = await recoveringAdapter.reserve(
      new Date("2026-01-01T00:00:02.000Z"),
    );

    expect(recovered).toHaveLength(1);
    expect(redelivered?.job.jobId).toBe(job.jobId);
    expect(redelivered?.job.idempotencyKey).toBe(job.idempotencyKey);
    if (!redelivered) {
      throw new Error("Expected recovered Redis reservation");
    }
    await recoveringAdapter.acknowledge(redelivered);
    await recoveringAdapter.disconnect();
  });

  it("does not recover non-stale in-flight work", async () => {
    if (!redisUrl) {
      throw new Error("Redis URL unavailable");
    }

    const adapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await adapter.connect();

    await adapter.publish(makeJob());
    const reservation = await adapter.reserve(
      new Date("2026-01-01T00:00:10.000Z"),
    );
    if (!reservation) {
      throw new Error("Expected non-stale Redis reservation");
    }
    const recovered = await adapter.recoverStale(
      new Date("2026-01-01T00:00:09.999Z"),
    );

    expect(recovered).toHaveLength(0);
    await adapter.acknowledge(reservation);
    await adapter.disconnect();
  });

  it("rejects unsafe payloads before writing to Redis", async () => {
    if (!redisUrl) {
      throw new Error("Redis URL unavailable");
    }

    const adapter = new RedisQueueAdapter({
      queueName,
      url: redisUrl,
    });
    await adapter.connect();

    await expect(
      adapter.publish({
        ...makeJob(),
        payload: {
          nested: Object.fromEntries([["pass" + "word", "redacted fixture"]]),
        },
      }),
    ).rejects.toThrow("Forbidden queue payload field");
    await adapter.disconnect();
  });
});

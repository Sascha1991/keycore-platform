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
    await cleanupClient?.quit();
  });

  it("round-trips a safe job envelope", async () => {
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
    await expect(adapter.take(1)).resolves.toEqual(
      expect.objectContaining({
        idempotencyKey: job.idempotencyKey,
        jobType: job.jobType,
      }),
    );
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

import { randomUUID } from "node:crypto";

import { createClient, type RedisClientType } from "redis";

import type {
  JobEnvelope,
  QueuePort,
  SafePayload,
} from "../../packages/platform/src/contracts.js";
import { validateSafePayload } from "../../packages/platform/src/contracts.js";

export interface RedisQueueConfig {
  readonly url: string;
  readonly queueName: string;
}

export interface ReservedJob {
  readonly job: JobEnvelope;
  readonly reservationToken: string;
}

export interface QueuePublisher {
  publish(job: JobEnvelope): Promise<void>;
}

interface RedisDeliveryRecord {
  readonly deliveryId: string;
  readonly enqueuedAt: string;
  readonly job: JobEnvelope;
}

const reserveScript = `
  local job = redis.call('RPOP', KEYS[1])
  if not job then
    return nil
  end
  redis.call('ZADD', KEYS[2], ARGV[1], job)
  return job
`;

const recoverStaleScript = `
  local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
  for _, job in ipairs(jobs) do
    if redis.call('ZREM', KEYS[1], job) == 1 then
      redis.call('LPUSH', KEYS[2], job)
    end
  end
  return jobs
`;

export class RedisQueueAdapter implements QueuePort, QueuePublisher {
  private readonly client: RedisClientType;
  private readonly processingQueueName: string;
  private readonly queueName: string;

  public constructor(config: RedisQueueConfig, client?: RedisClientType) {
    this.client = client ?? createClient({ url: config.url });
    this.queueName = config.queueName;
    this.processingQueueName = `${config.queueName}:processing`;
  }

  public async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  public async enqueue<TPayload extends SafePayload>(
    job: JobEnvelope<TPayload>,
  ): Promise<void> {
    await this.publish(job);
  }

  public async publish(job: JobEnvelope): Promise<void> {
    validateSafePayload(job.payload);
    const record: RedisDeliveryRecord = {
      deliveryId: randomUUID(),
      enqueuedAt: new Date().toISOString(),
      job,
    };
    await this.client.lPush(this.queueName, JSON.stringify(record));
  }

  public async reserve(now: Date = new Date()): Promise<ReservedJob | null> {
    const raw = await this.client.sendCommand([
      "EVAL",
      reserveScript,
      "2",
      this.queueName,
      this.processingQueueName,
      now.getTime().toString(),
    ]);
    if (typeof raw !== "string") {
      return null;
    }

    const parsed = this.parseDeliveryRecord(raw);
    return {
      job: parsed.job,
      reservationToken: raw,
    };
  }

  public async acknowledge(reservation: ReservedJob): Promise<void> {
    await this.client.zRem(
      this.processingQueueName,
      reservation.reservationToken,
    );
  }

  public async fail(reservation: ReservedJob): Promise<void> {
    const removed = await this.client.zRem(
      this.processingQueueName,
      reservation.reservationToken,
    );
    if (removed > 0) {
      await this.client.lPush(this.queueName, reservation.reservationToken);
    }
  }

  public async recoverStale(
    olderThan: Date,
    limit = 100,
  ): Promise<ReservedJob[]> {
    const rawJobs = await this.client.sendCommand([
      "EVAL",
      recoverStaleScript,
      "2",
      this.processingQueueName,
      this.queueName,
      olderThan.getTime().toString(),
      limit.toString(),
    ]);

    if (!Array.isArray(rawJobs)) {
      return [];
    }

    return rawJobs
      .filter((raw): raw is string => typeof raw === "string")
      .map((raw) => ({
        job: this.parseDeliveryRecord(raw).job,
        reservationToken: raw,
      }));
  }

  public async take(): Promise<JobEnvelope | null> {
    const reserved = await this.reserve();
    return reserved?.job ?? null;
  }

  private parseDeliveryRecord(raw: string): RedisDeliveryRecord {
    const parsed = JSON.parse(raw) as RedisDeliveryRecord;
    validateSafePayload(parsed.job.payload);
    return parsed;
  }
}

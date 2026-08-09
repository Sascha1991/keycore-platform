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

export interface QueuePublisher {
  publish(job: JobEnvelope): Promise<void>;
}

export class RedisQueueAdapter implements QueuePort, QueuePublisher {
  private readonly client: RedisClientType;
  private readonly queueName: string;

  public constructor(config: RedisQueueConfig, client?: RedisClientType) {
    this.client = client ?? createClient({ url: config.url });
    this.queueName = config.queueName;
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
    await this.client.lPush(this.queueName, JSON.stringify(job));
  }

  public async take(timeoutSeconds = 1): Promise<JobEnvelope | null> {
    const result = await this.client.brPop(this.queueName, timeoutSeconds);
    if (!result) {
      return null;
    }

    const raw = Array.isArray(result) ? result[1] : result.element;
    const parsed = JSON.parse(raw) as JobEnvelope;
    validateSafePayload(parsed.payload);
    return parsed;
  }
}

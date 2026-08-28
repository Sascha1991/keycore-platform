import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import { correlationId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";

export type DeadLetterWorkType =
  "OUTBOX_DISPATCH" | "RECONCILIATION" | "NOTIFICATION" | "CATALOG_SYNC";
export type DeadLetterState = "OPEN" | "REPLAYING" | "RESOLVED";

export interface DeadLetterItem {
  readonly id: string;
  readonly workType: DeadLetterWorkType;
  readonly safeReferenceId: string;
  readonly attemptCount: number;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly state: DeadLetterState;
  readonly firstFailedAt: Date;
  readonly lastFailedAt: Date;
  readonly resolvedAt: Date | null;
  readonly recordVersion: number;
}

export interface DeadLetterRepository {
  createOrIncrement(input: DeadLetterItem): Promise<DeadLetterItem>;
  findById(id: string): Promise<DeadLetterItem | null>;
  claimReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null>;
  resolveReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null>;
  releaseReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null>;
}

export interface DeadLetterReplayAuthorityPort {
  authorize(input: {
    readonly deadLetterId: string;
    readonly correlationId: string;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly actorReference: string }
    | { readonly status: "DENIED" }
  >;
}

export class FailClosedDeadLetterReplayAuthority implements DeadLetterReplayAuthorityPort {
  public async authorize(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export interface DeadLetterReplayPort {
  replay(
    item: DeadLetterItem,
  ): Promise<{ readonly status: "SUCCEEDED" | "FAILED" }>;
}

export class DeadLetterService {
  private readonly authority: DeadLetterReplayAuthorityPort;
  private readonly now: () => Date;
  private readonly audit: AuditEventPort | undefined;
  private readonly environment: AuditEvent["environment"];
  private readonly retryLimit: number;

  public constructor(
    private readonly repository: DeadLetterRepository,
    private readonly replayPort: DeadLetterReplayPort,
    options: {
      readonly authority?: DeadLetterReplayAuthorityPort;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
      readonly retryLimit?: number;
    } = {},
  ) {
    this.authority =
      options.authority ?? new FailClosedDeadLetterReplayAuthority();
    this.audit = options.audit;
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
    this.retryLimit = options.retryLimit ?? 5;
    if (!Number.isSafeInteger(this.retryLimit) || this.retryLimit < 1) {
      throw new Error("Dead-letter retry limit is invalid");
    }
  }

  public async recordFailure(input: {
    readonly workType: DeadLetterWorkType;
    readonly safeReferenceId: string;
    readonly attemptCount: number;
    readonly reasonCode: string;
    readonly correlationId: string;
  }): Promise<DeadLetterItem> {
    if (
      !safeReference(input.safeReferenceId) ||
      !safeCode(input.reasonCode) ||
      !safeReference(input.correlationId) ||
      !Number.isSafeInteger(input.attemptCount) ||
      input.attemptCount < this.retryLimit
    ) {
      throw new Error("Dead-letter metadata is invalid");
    }
    const now = this.now();
    return this.repository.createOrIncrement({
      attemptCount: input.attemptCount,
      correlationId: input.correlationId,
      firstFailedAt: now,
      id: randomUUID(),
      lastFailedAt: now,
      reasonCode: input.reasonCode,
      recordVersion: 1,
      resolvedAt: null,
      safeReferenceId: input.safeReferenceId,
      state: "OPEN",
      workType: input.workType,
    });
  }

  public async replay(input: {
    readonly deadLetterId: string;
    readonly expectedVersion: number;
    readonly correlationId: string;
  }): Promise<{
    readonly status: "RESOLVED" | "FAILED";
    readonly reasonCode: string;
  }> {
    const authorization = await this.authority.authorize({
      correlationId: input.correlationId,
      deadLetterId: input.deadLetterId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { reasonCode: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const item = await this.repository.findById(input.deadLetterId);
    if (!item || item.state !== "OPEN") {
      return { reasonCode: "DEAD_LETTER_NOT_REPLAYABLE", status: "FAILED" };
    }
    if (
      item.workType === "RECONCILIATION" &&
      item.reasonCode === "AMBIGUOUS_EXTERNAL_MUTATION"
    ) {
      return { reasonCode: "RECONCILIATION_REQUIRED", status: "FAILED" };
    }
    const claimed = await this.repository.claimReplay({
      expectedVersion: input.expectedVersion,
      id: input.deadLetterId,
      now: this.now(),
    });
    if (!claimed) return { reasonCode: "STALE_VERSION", status: "FAILED" };
    let result: Awaited<ReturnType<DeadLetterReplayPort["replay"]>>;
    try {
      result = await this.replayPort.replay(claimed);
    } catch {
      result = { status: "FAILED" };
    }
    if (result.status !== "SUCCEEDED") {
      await this.repository.releaseReplay({
        expectedVersion: claimed.recordVersion,
        id: claimed.id,
        now: this.now(),
      });
      return { reasonCode: "REPLAY_FAILED", status: "FAILED" };
    }
    const resolved = await this.repository.resolveReplay({
      expectedVersion: claimed.recordVersion,
      id: claimed.id,
      now: this.now(),
    });
    if (resolved) {
      try {
        await this.audit?.append({
          actor: {
            id: authorization.actorReference,
            type: "ADMIN",
          },
          correlationId: correlationId(input.correlationId),
          entity: { id: resolved.id, type: "DEAD_LETTER_ITEM" },
          environment: this.environment,
          eventType: "OPERATIONS_DEAD_LETTER_REPLAY_RESOLVED",
          metadata: {
            attemptCount: resolved.attemptCount,
            reasonCode: resolved.reasonCode,
            workType: resolved.workType,
          },
          outcome: "SUCCEEDED",
          reasonCode: "DEAD_LETTER_RESOLVED",
          timestampUtc: this.now(),
          uuid: randomUUID(),
        });
      } catch {
        // Durable DLQ state remains authoritative when global audit is unavailable.
      }
    }
    return resolved
      ? { reasonCode: "DEAD_LETTER_RESOLVED", status: "RESOLVED" }
      : { reasonCode: "REPLAY_OUTCOME_AMBIGUOUS", status: "FAILED" };
  }
}

const safeReference = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const safeCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);

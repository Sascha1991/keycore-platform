import { randomUUID } from "node:crypto";

import type {
  AuditActor,
  AuditEntity,
  AuditEvent,
  AuditEventType,
  AuditMetadata,
  AuditOutcome,
} from "../domain/audit.js";
import { validateAuditEvent } from "../domain/audit.js";
import type { CorrelationId } from "../domain/identifiers.js";
import type { AuditEventPort, ClockPort } from "../ports/core.js";

export const auditQueryRoles = [
  "ADMIN",
  "SECURITY_AUDITOR",
  "SUPPORT",
  "SYSTEM",
] as const;

export type AuditQueryRole = (typeof auditQueryRoles)[number];

export interface AuditQueryPrincipal {
  readonly actor: AuditActor;
  readonly roles: readonly AuditQueryRole[];
}

export interface AuditQueryFilters {
  readonly fromTimestampUtc?: Date;
  readonly toTimestampUtc?: Date;
  readonly eventType?: AuditEventType;
  readonly correlationId?: CorrelationId;
  readonly entity?: AuditEntity;
  readonly actor?: AuditActor;
  readonly outcome?: AuditOutcome;
  readonly reasonCode?: string;
}

export interface AuditQueryCursor {
  readonly timestampUtc: Date;
  readonly uuid: string;
}

export interface AuditQueryRequest {
  readonly principal: AuditQueryPrincipal;
  readonly filters: AuditQueryFilters;
  readonly pageSize?: number;
  readonly cursor?: AuditQueryCursor;
  readonly correlationId: CorrelationId;
  readonly environment: AuditEvent["environment"];
}

export interface AuthorizedAuditQuery {
  readonly filters: AuditQueryFilters;
  readonly pageSize: number;
  readonly cursor?: AuditQueryCursor;
}

export interface AuditQueryPage {
  readonly events: readonly AuditEvent[];
  readonly nextCursor?: AuditQueryCursor;
}

export interface AuditQueryAuthorizationDecision {
  readonly allowed: boolean;
  readonly reasonCode: string;
}

export interface AuditQueryAuthorizationPort {
  authorizeQuery(
    request: AuditQueryRequest,
  ): Promise<AuditQueryAuthorizationDecision>;
}

export interface AuditQueryRepositoryPort {
  query(request: AuthorizedAuditQuery): Promise<AuditQueryPage>;
}

const maxAuditQueryPageSize = 100;
const defaultAuditQueryPageSize = 50;

const sanitizePageSize = (pageSize: number | undefined): number => {
  if (pageSize === undefined) {
    return defaultAuditQueryPageSize;
  }

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Audit query page size must be a positive integer");
  }

  return Math.min(pageSize, maxAuditQueryPageSize);
};

const filterSummary = (filters: AuditQueryFilters): AuditMetadata => ({
  actorId: filters.actor?.id ?? null,
  actorType: filters.actor?.type ?? null,
  correlationId: filters.correlationId ?? null,
  entityId: filters.entity?.id ?? null,
  entityType: filters.entity?.type ?? null,
  eventType: filters.eventType ?? null,
  fromTimestampUtc: filters.fromTimestampUtc?.toISOString() ?? null,
  outcome: filters.outcome ?? null,
  reasonCode: filters.reasonCode ?? null,
  toTimestampUtc: filters.toTimestampUtc?.toISOString() ?? null,
});

export class AuditAppendService implements AuditEventPort {
  public constructor(private readonly auditEvents: AuditEventPort) {}

  public async append(event: AuditEvent): Promise<void> {
    await this.auditEvents.append(validateAuditEvent(event));
  }
}

export class AuditQueryService {
  public constructor(
    private readonly authorization: AuditQueryAuthorizationPort,
    private readonly repository: AuditQueryRepositoryPort,
    private readonly auditEvents: AuditEventPort,
    private readonly clock: ClockPort,
  ) {}

  public async query(request: AuditQueryRequest): Promise<AuditQueryPage> {
    const decision = await this.authorization.authorizeQuery(request);
    const pageSize = sanitizePageSize(request.pageSize);

    if (!decision.allowed) {
      await this.auditQueryAccess(request, "AUDIT_QUERY_DENIED", "DENIED", {
        deniedReasonCode: decision.reasonCode,
        requestedPageSize: pageSize,
      });
      throw new Error("Audit query denied");
    }

    const authorizedQuery: AuthorizedAuditQuery = {
      filters: request.filters,
      pageSize,
    };
    const page = await this.repository.query(
      request.cursor
        ? { ...authorizedQuery, cursor: request.cursor }
        : authorizedQuery,
    );

    await this.auditQueryAccess(request, "AUDIT_QUERY_EXECUTED", "SUCCEEDED", {
      requestedPageSize: pageSize,
      returnedCount: page.events.length,
    });

    return page;
  }

  private async auditQueryAccess(
    request: AuditQueryRequest,
    eventType: "AUDIT_QUERY_DENIED" | "AUDIT_QUERY_EXECUTED",
    outcome: AuditOutcome,
    extraMetadata: AuditMetadata,
  ): Promise<void> {
    await this.auditEvents.append(
      validateAuditEvent({
        actor: request.principal.actor,
        correlationId: request.correlationId,
        entity: { id: "audit-events", type: "AUDIT_LOG" },
        environment: request.environment,
        eventType,
        metadata: {
          ...filterSummary(request.filters),
          ...extraMetadata,
        },
        outcome,
        reasonCode:
          eventType === "AUDIT_QUERY_DENIED"
            ? "AUDIT_QUERY_DENIED"
            : "AUDIT_QUERY_EXECUTED",
        timestampUtc: this.clock.now(),
        uuid: randomUUID(),
      }),
    );
  }
}

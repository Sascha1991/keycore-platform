import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import { correlationId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";

export const operationsCapabilities = [
  "PROCUREMENT_CREATE",
  "SUPPLIER_KEY_RETRIEVAL",
  "CUSTOMER_KEY_DELIVERY",
  "SUPPLIER_CLAIM_SUBMISSION",
] as const;

export type OperationsCapability = (typeof operationsCapabilities)[number];
export type OperationsControlState = "ENABLED" | "PAUSED";
export type OperationsControlReasonCode =
  | "MAINTENANCE"
  | "INCIDENT_RESPONSE"
  | "SUPPLIER_INCIDENT"
  | "SECURITY_INCIDENT"
  | "MANUAL_OPERATIONS_PAUSE";

export interface OperationsControl {
  readonly capability: OperationsCapability;
  readonly state: OperationsControlState;
  readonly reasonCode: OperationsControlReasonCode | null;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OperationsControlEvent {
  readonly id: string;
  readonly capability: OperationsCapability;
  readonly eventType: "CONTROL_PAUSED" | "CONTROL_RESUMED";
  readonly fromState: OperationsControlState;
  readonly toState: OperationsControlState;
  readonly reasonCode: OperationsControlReasonCode | null;
  readonly actorReference: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface OperationsControlRepository {
  findControl(
    capability: OperationsCapability,
  ): Promise<OperationsControl | null>;
  changeControl(input: {
    readonly capability: OperationsCapability;
    readonly desiredState: OperationsControlState;
    readonly reasonCode: OperationsControlReasonCode | null;
    readonly expectedVersion: number;
    readonly event: OperationsControlEvent;
  }): Promise<
    | {
        readonly status: "UPDATED" | "REPLAY";
        readonly control: OperationsControl;
      }
    | {
        readonly status: "STALE_VERSION" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND";
      }
  >;
}

export type OperationsControlGateResult =
  | { readonly status: "ALLOWED" }
  | {
      readonly status: "DENIED";
      readonly reasonCode:
        "OPERATIONS_CONTROL_PAUSED" | "OPERATIONS_CONTROL_UNAVAILABLE";
    };

export interface OperationsControlGate {
  evaluate(
    capability: OperationsCapability,
  ): Promise<OperationsControlGateResult>;
}

export class FailClosedOperationsControlGate implements OperationsControlGate {
  public async evaluate(): Promise<OperationsControlGateResult> {
    return { reasonCode: "OPERATIONS_CONTROL_UNAVAILABLE", status: "DENIED" };
  }
}

export type OperationsControlAuthorityAction = "PAUSE" | "RESUME";

export interface OperationsControlAuthorityPort {
  authorize(input: {
    readonly action: OperationsControlAuthorityAction;
    readonly capability: OperationsCapability;
    readonly correlationId: string;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly actorReference: string }
    | { readonly status: "DENIED" }
  >;
}

export class FailClosedOperationsControlAuthority implements OperationsControlAuthorityPort {
  public async authorize(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export type ChangeOperationsControlResult =
  | {
      readonly status: "UPDATED" | "REPLAY";
      readonly control: OperationsControl;
    }
  | {
      readonly status: "FAILED";
      readonly code:
        | "BAD_REQUEST"
        | "UNTRUSTED_AUTHORITY"
        | "STALE_VERSION"
        | "IDEMPOTENCY_CONFLICT"
        | "CONTROL_UNAVAILABLE";
    };

const reasonCodes = new Set<OperationsControlReasonCode>([
  "MAINTENANCE",
  "INCIDENT_RESPONSE",
  "SUPPLIER_INCIDENT",
  "SECURITY_INCIDENT",
  "MANUAL_OPERATIONS_PAUSE",
]);

export class OperationsControlService implements OperationsControlGate {
  private readonly authority: OperationsControlAuthorityPort;
  private readonly now: () => Date;
  private readonly audit: AuditEventPort | undefined;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly repository: OperationsControlRepository,
    options: {
      readonly authority?: OperationsControlAuthorityPort;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    } = {},
  ) {
    this.authority =
      options.authority ?? new FailClosedOperationsControlAuthority();
    this.audit = options.audit;
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
  }

  public async evaluate(
    capability: OperationsCapability,
  ): Promise<OperationsControlGateResult> {
    try {
      const control = await this.repository.findControl(capability);
      if (!isValidControl(control, capability)) {
        return unavailable();
      }
      return control.state === "ENABLED"
        ? { status: "ALLOWED" }
        : { reasonCode: "OPERATIONS_CONTROL_PAUSED", status: "DENIED" };
    } catch {
      return unavailable();
    }
  }

  public async changeControl(input: {
    readonly capability: OperationsCapability;
    readonly desiredState: OperationsControlState;
    readonly reasonCode?: OperationsControlReasonCode | null;
    readonly expectedVersion: number;
    readonly operationId: string;
    readonly correlationId: string;
  }): Promise<ChangeOperationsControlResult> {
    const reasonCode = input.reasonCode ?? null;
    if (
      !operationsCapabilities.includes(input.capability) ||
      !["ENABLED", "PAUSED"].includes(input.desiredState) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion <= 0 ||
      !isSafeReference(input.operationId) ||
      !isSafeReference(input.correlationId) ||
      (input.desiredState === "PAUSED" &&
        (reasonCode === null || !reasonCodes.has(reasonCode))) ||
      (input.desiredState === "ENABLED" && reasonCode !== null)
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const action = input.desiredState === "PAUSED" ? "PAUSE" : "RESUME";
    const authorization = await this.authority.authorize({
      action,
      capability: input.capability,
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeReference(authorization.actorReference)
    ) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const current = await this.repository.findControl(input.capability);
    if (!isValidControl(current, input.capability)) {
      return { code: "CONTROL_UNAVAILABLE", status: "FAILED" };
    }
    try {
      const changed = await this.repository.changeControl({
        capability: input.capability,
        desiredState: input.desiredState,
        event: {
          actorReference: authorization.actorReference,
          capability: input.capability,
          correlationId: input.correlationId,
          eventType:
            input.desiredState === "PAUSED"
              ? "CONTROL_PAUSED"
              : "CONTROL_RESUMED",
          fromState: input.desiredState === "PAUSED" ? "ENABLED" : "PAUSED",
          id: randomUUID(),
          occurredAt: this.now(),
          operationId: input.operationId,
          reasonCode,
          toState: input.desiredState,
        },
        expectedVersion: input.expectedVersion,
        reasonCode,
      });
      if (changed.status === "UPDATED" || changed.status === "REPLAY") {
        if (changed.status === "UPDATED") {
          await this.auditChange(
            changed.control,
            authorization.actorReference,
            input.operationId,
            input.correlationId,
          );
        }
        return changed;
      }
      return {
        code:
          changed.status === "STALE_VERSION"
            ? "STALE_VERSION"
            : changed.status === "IDEMPOTENCY_CONFLICT"
              ? "IDEMPOTENCY_CONFLICT"
              : "CONTROL_UNAVAILABLE",
        status: "FAILED",
      };
    } catch {
      return { code: "CONTROL_UNAVAILABLE", status: "FAILED" };
    }
  }

  private async auditChange(
    control: OperationsControl,
    actorReference: string,
    operationId: string,
    rawCorrelationId: string,
  ): Promise<void> {
    try {
      await this.audit?.append({
        actor: { id: actorReference, type: "ADMIN" },
        correlationId: correlationId(rawCorrelationId),
        entity: { id: control.capability, type: "OPERATIONS_CONTROL" },
        environment: this.environment,
        eventType:
          control.state === "PAUSED"
            ? "OPERATIONS_CONTROL_PAUSED"
            : "OPERATIONS_CONTROL_RESUMED",
        metadata: {
          capability: control.capability,
          operationId,
          recordVersion: control.recordVersion,
          state: control.state,
        },
        outcome: "SUCCEEDED",
        reasonCode: control.reasonCode ?? "OPERATIONS_CONTROL_RESUMED",
        timestampUtc: this.now(),
        uuid: randomUUID(),
      });
    } catch {
      // Durable control history remains authoritative when global audit is unavailable.
    }
  }
}

export const evaluateHighRiskOperation = async (
  gate: OperationsControlGate | undefined,
  capability: OperationsCapability,
): Promise<OperationsControlGateResult> => {
  try {
    return await (gate ?? new FailClosedOperationsControlGate()).evaluate(
      capability,
    );
  } catch {
    return unavailable();
  }
};

const isValidControl = (
  control: OperationsControl | null,
  capability: OperationsCapability,
): control is OperationsControl =>
  control !== null &&
  control.capability === capability &&
  (control.state === "ENABLED" || control.state === "PAUSED") &&
  Number.isSafeInteger(control.recordVersion) &&
  control.recordVersion > 0 &&
  control.createdAt instanceof Date &&
  !Number.isNaN(control.createdAt.getTime()) &&
  control.updatedAt instanceof Date &&
  !Number.isNaN(control.updatedAt.getTime()) &&
  control.createdAt.getTime() <= control.updatedAt.getTime() &&
  ((control.state === "PAUSED" &&
    control.reasonCode !== null &&
    reasonCodes.has(control.reasonCode)) ||
    (control.state === "ENABLED" && control.reasonCode === null));

const isSafeReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 128 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const unavailable = (): OperationsControlGateResult => ({
  reasonCode: "OPERATIONS_CONTROL_UNAVAILABLE",
  status: "DENIED",
});

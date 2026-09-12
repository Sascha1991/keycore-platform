import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
} from "../contracts.js";
import { validateAuditEvent } from "../contracts.js";
import {
  hashAdminPassword,
  normalizeAdminEmail,
  validAdminPasswordInput,
} from "./admin-password-authentication.js";

export const adminPasswordResetLifetimeMs = 45 * 60 * 1000;
export const adminPasswordResetThrottleMs = 5 * 60 * 1000;

export interface AdminPasswordResetRepository {
  begin(input: {
    readonly emailNormalized: string;
    readonly expiresAt: Date;
    readonly issuedAt: Date;
    readonly resetId: string;
    readonly throttleSince: Date;
    readonly tokenHash: string;
  }): Promise<
    | {
        readonly status: "ISSUED";
        readonly adminId: string;
        readonly emailNormalized: string;
      }
    | { readonly status: "IGNORED" | "THROTTLED" }
  >;
  complete(input: {
    readonly completedAt: Date;
    readonly passwordHash: string;
    readonly tokenHash: string;
  }): Promise<{ readonly adminId: string } | null>;
}

export interface AdminPasswordResetDeliveryPort {
  sendPasswordReset(input: {
    readonly emailNormalized: string;
    readonly expiresAt: Date;
    readonly rawToken: string;
  }): Promise<{ readonly status: "ACCEPTED" | "FAILED" }>;
}

export interface AdminPasswordResetPort {
  request(
    email: string,
    correlationId: CorrelationId,
  ): Promise<{ readonly accepted: true }>;
  reset(
    rawToken: string,
    password: string,
    passwordConfirmation: string,
    correlationId: CorrelationId,
  ): Promise<
    | { readonly status: "COMPLETED" }
    | {
        readonly status:
          "INVALID_OR_EXPIRED" | "PASSWORD_INVALID" | "PASSWORD_MISMATCH";
      }
  >;
}

export class AdminPasswordResetService implements AdminPasswordResetPort {
  public constructor(
    private readonly repository: AdminPasswordResetRepository,
    private readonly delivery: AdminPasswordResetDeliveryPort,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async request(
    email: string,
    correlationId: CorrelationId,
  ): Promise<{ readonly accepted: true }> {
    const issuedAt = this.now();
    const emailNormalized = normalizeAdminEmail(email);
    if (!emailNormalized) {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_REQUESTED",
        issuedAt,
      );
      return { accepted: true };
    }

    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      issuedAt.getTime() + adminPasswordResetLifetimeMs,
    );
    const result = await this.repository.begin({
      emailNormalized,
      expiresAt,
      issuedAt,
      resetId: randomUUID(),
      throttleSince: new Date(
        issuedAt.getTime() - adminPasswordResetThrottleMs,
      ),
      tokenHash: hashAdminPasswordResetToken(rawToken),
    });
    if (result.status !== "ISSUED") {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_REQUESTED",
        issuedAt,
      );
      return { accepted: true };
    }

    const delivered = await this.delivery.sendPasswordReset({
      emailNormalized: result.emailNormalized,
      expiresAt,
      rawToken,
    });
    await this.auditReset(
      result.adminId,
      correlationId,
      delivered.status === "ACCEPTED" ? "SUCCEEDED" : "FAILED",
      delivered.status === "ACCEPTED"
        ? "ADMIN_PASSWORD_RESET_REQUESTED"
        : "ADMIN_PASSWORD_RESET_DELIVERY_FAILED",
      issuedAt,
    );
    return { accepted: true };
  }

  public async reset(
    rawToken: string,
    password: string,
    passwordConfirmation: string,
    correlationId: CorrelationId,
  ): Promise<
    | { readonly status: "COMPLETED" }
    | {
        readonly status:
          "INVALID_OR_EXPIRED" | "PASSWORD_INVALID" | "PASSWORD_MISMATCH";
      }
  > {
    const completedAt = this.now();
    if (password !== passwordConfirmation) {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_FAILED",
        completedAt,
      );
      return { status: "PASSWORD_MISMATCH" };
    }
    if (!validAdminPasswordInput(password)) {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_FAILED",
        completedAt,
      );
      return { status: "PASSWORD_INVALID" };
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(rawToken)) {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_FAILED",
        completedAt,
      );
      return { status: "INVALID_OR_EXPIRED" };
    }

    const completed = await this.repository.complete({
      completedAt,
      passwordHash: await hashAdminPassword(password),
      tokenHash: hashAdminPasswordResetToken(rawToken),
    });
    if (!completed) {
      await this.auditReset(
        "anonymous",
        correlationId,
        "DENIED",
        "ADMIN_PASSWORD_RESET_FAILED",
        completedAt,
      );
      return { status: "INVALID_OR_EXPIRED" };
    }
    await this.auditReset(
      completed.adminId,
      correlationId,
      "SUCCEEDED",
      "ADMIN_PASSWORD_RESET_COMPLETED",
      completedAt,
    );
    return { status: "COMPLETED" };
  }

  private async auditReset(
    actorId: string,
    correlationId: CorrelationId,
    outcome: AuditEvent["outcome"],
    reasonCode: string,
    timestampUtc: Date,
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: actorId, type: "ADMIN" },
        correlationId,
        entity: { id: "admin-portal", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "AUTH_SECURITY_EVENT",
        metadata: { authenticationMethod: "PASSWORD_RESET" },
        outcome,
        reasonCode,
        timestampUtc,
        uuid: randomUUID(),
      }),
    );
  }
}

export const hashAdminPasswordResetToken = (rawToken: string): string =>
  createHash("sha256").update(rawToken, "utf8").digest("hex");

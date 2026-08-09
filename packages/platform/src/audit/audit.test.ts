import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AuditAppendService,
  AuditQueryService,
  correlationId,
  validateAuditEvent,
  validateAuditEventType,
  validateAuditMetadata,
  type AuditEvent,
  type AuditEventPort,
  type AuditQueryAuthorizationPort,
  type AuditQueryRepositoryPort,
} from "../contracts.js";

const auditEvent = (override: Partial<AuditEvent> = {}): AuditEvent => ({
  actor: { id: "system", type: "SYSTEM" },
  correlationId: correlationId("corr-audit-test"),
  entity: { id: "entity-1", type: "TEST_ENTITY" },
  environment: "CI",
  eventType: "KEY_REVEALED",
  metadata: { keyVersion: "local-v1", orderLineId: randomUUID() },
  outcome: "SUCCEEDED",
  reasonCode: "TEST",
  timestampUtc: new Date("2026-01-01T00:00:00.000Z"),
  uuid: randomUUID(),
  ...override,
});

describe("audit metadata validation", () => {
  it("accepts safe operational metadata values", () => {
    expect(
      validateAuditMetadata({
        nested: { retryCount: 2 },
        orderLineId: randomUUID(),
        safeArray: [{ phase: "test" }],
        keyVersion: "local-v1",
      }),
    ).toEqual({
      nested: { retryCount: 2 },
      orderLineId: expect.any(String),
      safeArray: [{ phase: "test" }],
      keyVersion: "local-v1",
    });
  });

  it("rejects secret canary field names at any depth before persistence", () => {
    const rejectedMetadata = [
      { productKey: "canary" },
      { nested: { plaintextKey: "canary" } },
      { APISECRET: "canary" },
      { array: [{ password: "canary" }] },
      { encrypted: { ciphertext: "canary" } },
      { wrappedDataEncryptionKey: "canary" },
      { requestBody: { value: "not persisted" } },
    ];

    for (const metadata of rejectedMetadata) {
      expect(() => validateAuditMetadata(metadata)).toThrow(/forbidden field/u);
    }
  });

  it("rejects unsafe metadata values and oversized payloads", () => {
    expect(() =>
      validateAuditMetadata({
        rawBytes: Buffer.from("canary"),
      } as unknown as Record<string, never>),
    ).toThrow(/unsafe|binary/u);
    expect(() =>
      validateAuditMetadata({
        error: new Error("boom"),
      } as unknown as Record<string, never>),
    ).toThrow(/unsafe/u);
    expect(() => validateAuditMetadata({ huge: "x".repeat(1_025) })).toThrow(
      /too large/u,
    );
    expect(() =>
      validateAuditMetadata({
        deep: { a: { b: { c: { d: { e: { f: "too-deep" } } } } } },
      }),
    ).toThrow(/nesting/u);
    expect(() =>
      validateAuditMetadata(
        Object.fromEntries(
          Array.from({ length: 45 }, (_, index) => [
            `field${index}`,
            "x".repeat(200),
          ]),
        ),
      ),
    ).toThrow(/payload/u);
  });

  it("rejects arbitrary event types but allows approved future prefixes", () => {
    expect(validateAuditEventType("KEY_STORED")).toBe("KEY_STORED");
    expect(validateAuditEventType("PAYMENT_CAPTURED")).toBe("PAYMENT_CAPTURED");
    expect(() => validateAuditEventType("FREEFORM")).toThrow(
      "Unsupported audit event type",
    );
  });

  it("validates full audit events through the append service", async () => {
    const port: AuditEventPort = {
      append: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuditAppendService(port);

    await service.append(auditEvent());
    await expect(
      service.append(
        auditEvent({
          metadata: { nested: { authorization: "Bearer canary" } },
        }),
      ),
    ).rejects.toThrow("forbidden field");
    expect(port.append).toHaveBeenCalledTimes(1);
  });
});

describe("audit query service", () => {
  const clock = { now: () => new Date("2026-01-02T00:00:00.000Z") };
  const principal = {
    actor: { id: "auditor-1", type: "ADMIN" } as const,
    roles: ["SECURITY_AUDITOR"] as const,
  };

  it("authorizes before reading and records a safe executed audit event", async () => {
    const returnedEvent = auditEvent();
    const authorization: AuditQueryAuthorizationPort = {
      authorizeQuery: vi.fn().mockResolvedValue({
        allowed: true,
        reasonCode: "SECURITY_AUDITOR_READ",
      }),
    };
    const repository: AuditQueryRepositoryPort = {
      query: vi.fn().mockResolvedValue({ events: [returnedEvent] }),
    };
    const auditEvents: AuditEventPort = {
      append: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuditQueryService(
      authorization,
      repository,
      auditEvents,
      clock,
    );

    const page = await service.query({
      correlationId: correlationId("corr-query"),
      environment: "CI",
      filters: { eventType: "KEY_REVEALED" },
      pageSize: 250,
      principal,
    });

    expect(page.events).toEqual([returnedEvent]);
    expect(repository.query).toHaveBeenCalledWith({
      filters: { eventType: "KEY_REVEALED" },
      pageSize: 100,
    });
    expect(auditEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AUDIT_QUERY_EXECUTED",
        metadata: expect.objectContaining({
          eventType: "KEY_REVEALED",
          requestedPageSize: 100,
          returnedCount: 1,
        }),
      }),
    );
  });

  it("denies before repository access and audits the denial", async () => {
    const authorization: AuditQueryAuthorizationPort = {
      authorizeQuery: vi.fn().mockResolvedValue({
        allowed: false,
        reasonCode: "SUPPORT_SCOPE_RESTRICTED",
      }),
    };
    const repository: AuditQueryRepositoryPort = {
      query: vi.fn().mockResolvedValue({ events: [] }),
    };
    const auditEvents: AuditEventPort = {
      append: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuditQueryService(
      authorization,
      repository,
      auditEvents,
      clock,
    );

    await expect(
      service.query({
        correlationId: correlationId("corr-denied"),
        environment: "CI",
        filters: {},
        pageSize: 10,
        principal: {
          actor: { id: "support-1", type: "ADMIN" },
          roles: ["SUPPORT"],
        },
      }),
    ).rejects.toThrow("Audit query denied");

    expect(repository.query).not.toHaveBeenCalled();
    expect(auditEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AUDIT_QUERY_DENIED",
        metadata: expect.objectContaining({
          deniedReasonCode: "SUPPORT_SCOPE_RESTRICTED",
        }),
        outcome: "DENIED",
      }),
    );
  });

  it("rejects invalid query page sizes", async () => {
    const service = new AuditQueryService(
      {
        authorizeQuery: vi.fn().mockResolvedValue({
          allowed: true,
          reasonCode: "OK",
        }),
      },
      { query: vi.fn().mockResolvedValue({ events: [] }) },
      { append: vi.fn().mockResolvedValue(undefined) },
      clock,
    );

    await expect(
      service.query({
        correlationId: correlationId("corr-invalid-page"),
        environment: "CI",
        filters: {},
        pageSize: 0,
        principal,
      }),
    ).rejects.toThrow("page size");
  });

  it("keeps audit-of-audit event metadata secret-safe", () => {
    expect(() =>
      validateAuditEvent(
        auditEvent({
          eventType: "AUDIT_QUERY_EXECUTED",
          metadata: {
            entityType: "ORDER_LINE",
            resultPayloadIncluded: false,
          },
        }),
      ),
    ).not.toThrow();
  });
});

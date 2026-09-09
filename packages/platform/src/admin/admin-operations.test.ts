import { describe, expect, it } from "vitest";

import {
  AdminAccessError,
  AdminOperationsService,
  correlationId,
  type AdminOperationsRepository,
  type AdminOperationsControlMutationPort,
  type AdminPrincipal,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";

const secret = randomBytes(32).toString("hex");
const requestId = correlationId("admin-operations-test");

describe("AdminOperationsService", () => {
  it("enforces section capabilities and audits bounded reads", async () => {
    const audit = new MemoryAudit();
    const repository = new MemoryRepository();
    const service = new AdminOperationsService(repository, audit, secret, "CI");

    const page = await service.listCustomers(
      owner(),
      { limit: 25, search: "example.test" },
      requestId,
    );
    expect(page.items).toHaveLength(1);
    expect(repository.customerInput).toMatchObject({
      limit: 25,
      search: "example.test",
    });
    expect(audit.events.at(-1)?.reasonCode).toBe("ADMIN_CUSTOMERS_VIEWED");

    await expect(
      service.listCustomers(support(), {}, requestId),
    ).resolves.toMatchObject({ items: expect.any(Array) });
    await expect(
      service.listProducts(support(), {}, requestId),
    ).rejects.toBeInstanceOf(AdminAccessError);
    await expect(service.finance(support(), requestId)).rejects.toMatchObject({
      reasonCode: "ADMIN_ACCESS_DENIED",
    });
  });

  it("binds cursors to the exact section and filter fingerprint", async () => {
    const repository = new MemoryRepository(true);
    const service = new AdminOperationsService(
      repository,
      new MemoryAudit(),
      secret,
      "CI",
    );
    const first = await service.listCustomers(
      owner(),
      { status: "VERIFIED" },
      requestId,
    );
    expect(first.nextCursorValue).toBeTruthy();
    const cursor = required(first.nextCursorValue);

    await service.listCustomers(
      owner(),
      { cursor, status: "VERIFIED" },
      requestId,
    );
    expect(repository.customerInput?.after).toEqual({
      id: "20000000-0000-4000-8000-000000000001",
      sortValue: "2026-09-01T09:00:00.000Z",
    });

    await expect(
      service.listCustomers(
        owner(),
        { cursor, status: "UNVERIFIED" },
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await expect(
      service.listProducts(owner(), { cursor }, requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
  });

  it("rejects unbounded or control-character input", async () => {
    const service = new AdminOperationsService(
      new MemoryRepository(),
      new MemoryAudit(),
      secret,
      "CI",
    );
    await expect(
      service.listSupportCases(
        owner(),
        { search: "bad\u0000value" },
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await expect(
      service.listSupportCases(owner(), { limit: 101 }, requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await expect(
      service.listSupportCases(owner(), { status: "open" }, requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
  });

  it("requires control-management authority before delegating a versioned mutation", async () => {
    const mutation = new MemoryControlMutation();
    const service = new AdminOperationsService(
      new MemoryRepository(),
      new MemoryAudit(),
      secret,
      "CI",
      () => new Date("2026-09-01T09:00:00.000Z"),
      mutation,
    );
    const input = {
      capability: "PROCUREMENT_CREATE" as const,
      desiredState: "PAUSED" as const,
      expectedVersion: 1,
      operationId: "admin-control-operation",
      reasonCode: "MAINTENANCE" as const,
    };

    await expect(
      service.changeControl(support(), input, requestId),
    ).rejects.toMatchObject({
      reasonCode: "ADMIN_ACCESS_DENIED",
    });
    await expect(
      service.changeControl(owner(), input, requestId),
    ).resolves.toMatchObject({
      status: "UPDATED",
    });
    expect(mutation.inputs).toHaveLength(1);
    expect(mutation.inputs[0]).toMatchObject({
      capability: "PROCUREMENT_CREATE",
      correlationId: requestId,
      desiredState: "PAUSED",
      expectedVersion: 1,
      reasonCode: "MAINTENANCE",
    });
  });
});

class MemoryRepository implements AdminOperationsRepository {
  public customerInput?: Parameters<
    AdminOperationsRepository["listCustomers"]
  >[0];
  public constructor(private readonly withCursor = false) {}
  public async listCustomers(
    input: Parameters<AdminOperationsRepository["listCustomers"]>[0],
  ) {
    this.customerInput = input;
    return {
      items: [customer],
      ...(this.withCursor
        ? {
            nextCursor: {
              id: customer.customerId,
              sortValue: customer.createdAt.toISOString(),
            },
          }
        : {}),
    };
  }
  public async listProducts() {
    return { items: [] };
  }
  public async listSuppliers() {
    return { items: [] };
  }
  public async listSupportCases() {
    return { items: [] };
  }
  public async listFraudReviews() {
    return { items: [] };
  }
  public async listOperationsControls() {
    return [];
  }
  public async financeSummary() {
    return [];
  }
}

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class MemoryControlMutation implements AdminOperationsControlMutationPort {
  public readonly inputs: Parameters<
    AdminOperationsControlMutationPort["change"]
  >[0][] = [];
  public async change(
    input: Parameters<AdminOperationsControlMutationPort["change"]>[0],
  ) {
    this.inputs.push(input);
    return {
      control: {
        capability: input.capability,
        createdAt: new Date("2026-09-01T08:00:00.000Z"),
        reasonCode: input.reasonCode,
        recordVersion: input.expectedVersion + 1,
        state: input.desiredState,
        updatedAt: new Date("2026-09-01T09:00:00.000Z"),
      },
      status: "UPDATED" as const,
    };
  }
}

const customer = {
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  customerId: "20000000-0000-4000-8000-000000000001",
  email: "customer@example.test",
  lastOrderAt: null,
  orderCount: 0,
  verificationState: "VERIFIED" as const,
};

const owner = (): AdminPrincipal => ({
  adminId: "a1000000-0000-4000-8000-000000000001",
  assurance: "MFA",
  displayName: "Owner",
  expiresAt: new Date("2026-09-10T00:00:00.000Z"),
  roles: ["PROJECT_OWNER"],
});
const support = (): AdminPrincipal => ({ ...owner(), roles: ["SUPPORT"] });
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected value");
  return value;
};
import { randomBytes } from "node:crypto";

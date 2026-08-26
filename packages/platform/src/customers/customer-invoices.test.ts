import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import {
  CustomerInvoiceAccessService,
  correlationId,
  currency,
  customerId,
  money,
  orderId,
  type AuditEvent,
  type AuthenticatedCustomerPrincipal,
  type CustomerAccountOrderProjection,
  type CustomerId,
} from "../contracts.js";

const now = new Date("2026-08-26T10:00:00.000Z");
const invoiceLeakMarker = "KEYRANO_KS0806_INVOICE_SECRET_DO_NOT_LEAK_642917";
const productKeyLeakMarker = "KEYRANO-KS0806-PRODUCT-KEY-DO-NOT-LEAK";

describe("customer invoice access foundation", () => {
  it("returns safe invoice metadata only for the authenticated order owner", async () => {
    const harness = invoiceHarness();
    const result = await harness.service.getInvoiceMetadata({
      correlationId: correlationId("invoice-owned"),
      orderId: harness.ownedOrder.orderId,
      principal: principal(harness.customerA),
    });

    expect(result).toEqual({
      invoice: {
        downloadAvailable: true,
        invoiceReference: "KR-INV-2026-0001",
        issuedAt: "2026-08-26T09:30:00.000Z",
        status: "AVAILABLE",
      },
      orderId: harness.ownedOrder.orderId,
      status: "OK",
    });
    expect(safeJson(result)).not.toContain(invoiceLeakMarker);
    expect(safeJson(result)).not.toContain(productKeyLeakMarker);
    expect(harness.audit.events.at(-1)).toMatchObject({
      eventType: "CUSTOMER_INVOICE_METADATA_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_INVOICE_METADATA_VIEWED",
    });
  });

  it("uses the same unavailable result for wrong owner and missing orders", async () => {
    const harness = invoiceHarness();
    const wrongOwner = await harness.service.getInvoiceMetadata({
      correlationId: correlationId("invoice-wrong-owner"),
      orderId: harness.otherOrder.orderId,
      principal: principal(harness.customerA),
    });
    const missing = await harness.service.getInvoiceMetadata({
      correlationId: correlationId("invoice-missing"),
      orderId: "99999999-9999-4999-8999-999999999999",
      principal: principal(harness.customerA),
    });

    expect(wrongOwner).toEqual({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    expect(missing).toEqual(wrongOwner);
    expect(
      harness.audit.events.filter(
        (event) => event.eventType === "CUSTOMER_INVOICE_METADATA_DENIED",
      ),
    ).toHaveLength(2);
  });

  it("does not treat malformed order IDs or unauthenticated principals as authority", async () => {
    const harness = invoiceHarness();
    await expect(
      harness.service.getInvoiceMetadata({
        correlationId: correlationId("invoice-bad-order"),
        orderId: "not-a-uuid",
        principal: principal(harness.customerA),
      }),
    ).resolves.toEqual({ code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" });
    await expect(
      harness.service.getInvoiceMetadata({
        correlationId: correlationId("invoice-test-principal"),
        orderId: harness.ownedOrder.orderId,
        principal: principal(harness.customerA, "TEST"),
      }),
    ).resolves.toEqual({
      code: "AUTHENTICATION_REQUIRED",
      status: "DENIED",
    });
  });

  it("keeps pending and failed invoice states metadata-only", async () => {
    const harness = invoiceHarness();
    const pending = await harness.service.getInvoiceMetadata({
      correlationId: correlationId("invoice-pending"),
      orderId: harness.pendingOrder.orderId,
      principal: principal(harness.customerA),
    });

    expect(pending).toEqual({
      invoice: { downloadAvailable: false, status: "PENDING" },
      orderId: harness.pendingOrder.orderId,
      status: "OK",
    });
    expect(safeJson(pending)).not.toMatch(/storage|tax|pdf|documentId/iu);
  });
});

const invoiceHarness = () => {
  const repository = new InMemoryCustomerAccountReadRepository();
  const audit = new CollectingAudit();
  const customerA = customerId("11111111-1111-4111-8111-111111111111");
  const customerB = customerId("22222222-2222-4222-8222-222222222222");
  const ownedOrder = orderFixture(
    customerA,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    {
      invoice: {
        downloadAvailable: true,
        invoiceReference: "KR-INV-2026-0001",
        issuedAt: new Date("2026-08-26T09:30:00.000Z"),
        status: "AVAILABLE",
      },
    },
  );
  const pendingOrder = orderFixture(
    customerA,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    {
      invoice: { downloadAvailable: false, status: "PENDING" },
    },
  );
  const otherOrder = orderFixture(
    customerB,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    {
      invoice: {
        downloadAvailable: true,
        invoiceReference: invoiceLeakMarker,
        status: "AVAILABLE",
      },
    },
  );
  [ownedOrder, pendingOrder, otherOrder].forEach((order) =>
    repository.addOrder(order),
  );
  return {
    audit,
    customerA,
    ownedOrder,
    otherOrder,
    pendingOrder,
    service: new CustomerInvoiceAccessService({
      audit,
      environment: "CI",
      now: () => now,
      repository,
    }),
  };
};

const orderFixture = (
  owner: CustomerId,
  id: string,
  options: {
    readonly invoice?: CustomerAccountOrderProjection["invoice"];
  },
): CustomerAccountOrderProjection => ({
  activation: null,
  createdAt: now,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: null,
  fulfillmentStatus: "PENDING",
  invoice: options.invoice ?? null,
  orderId: orderId(id),
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Synthetic invoice product",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(2599n, currency("EUR")),
  updatedAt: now,
});

const principal = (
  id: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance, provider: "TEST" },
  customerId: id,
});

class CollectingAudit {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );

import { describe, expect, it } from "vitest";

import {
  assertSafeSupplierError,
  currency,
  idempotencyKey,
  money,
  orderLineId,
  validateRegionEvidence,
  type Availability,
  type SupplierOfferId,
  type SupplierPort,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";

export interface SupplierContractTestSetup {
  readonly createSupplier: () => SupplierPort;
  readonly knownProductId: SupplierProductId;
  readonly missingProductId: SupplierProductId;
  readonly knownOfferId: SupplierOfferId;
  readonly missingOfferId: SupplierOfferId;
  readonly delayedOfferId: SupplierOfferId;
  readonly unavailableOfferId: SupplierOfferId;
}

export const runSupplierContractTests = (
  setup: SupplierContractTestSetup,
): void => {
  describe("supplier adapter contract", () => {
    it("exposes stable identity, contract version, and consistent capabilities", () => {
      const supplier = setup.createSupplier();

      expect(supplier.identity.supplierId).toEqual(expect.any(String));
      expect(supplier.identity.contractVersion.major).toBeGreaterThanOrEqual(1);
      expect(supplier.capabilities.supportsFullCatalog).toBe(true);
      expect(
        supplier.capabilities.supportsDelayedFulfillment
          ? supplier.capabilities.supportsPurchase
          : true,
      ).toBe(true);
      expect(
        supplier.capabilities.supportsKeyRetrieval
          ? supplier.retrieveKey
          : undefined,
      ).toBeDefined();
    });

    it("returns deterministic bounded catalog pages and empty tail pages", async () => {
      const supplier = setup.createSupplier();
      const first = await supplier.listCatalog({ limit: 2 });
      const again = await supplier.listCatalog({ limit: 2 });

      expect(first).toEqual(again);
      expect(first.items.length).toBeLessThanOrEqual(2);
      expect(first.nextCursor).toEqual(expect.any(String));

      if (!first.nextCursor) {
        throw new Error("Expected deterministic next cursor");
      }

      const second = await supplier.listCatalog({
        cursor: first.nextCursor,
        limit: 2,
      });
      expect(
        new Set(
          [...first.items, ...second.items].map(
            (item) => item.supplierProductId,
          ),
        ).size,
      ).toBe(first.items.length + second.items.length);

      const empty = await supplier.listCatalog({
        cursor: "mock:999",
        limit: 2,
      });
      expect(empty.items).toEqual([]);
    });

    it("supports deterministic delta catalog when declared", async () => {
      const supplier = setup.createSupplier();

      if (!supplier.capabilities.supportsDeltaCatalog) {
        await expect(
          supplier.listCatalogDelta?.({
            page: { limit: 10 },
            since: new Date("2026-01-01T00:00:00.000Z"),
          }),
        ).rejects.toThrow();
        return;
      }

      const changed = await supplier.listCatalogDelta?.({
        page: { limit: 2 },
        since: new Date("2026-01-01T00:01:30.000Z"),
      });
      const none = await supplier.listCatalogDelta?.({
        page: { limit: 10 },
        since: new Date("2026-01-02T00:00:00.000Z"),
      });

      expect(changed?.items.length).toBeGreaterThan(0);
      expect(changed?.items.length).toBeLessThanOrEqual(2);
      expect(none?.items).toEqual([]);
    });

    it("looks up products and offers predictably", async () => {
      const supplier = setup.createSupplier();

      await expect(supplier.getProduct(setup.knownProductId)).resolves.toEqual(
        expect.objectContaining({ supplierProductId: setup.knownProductId }),
      );
      await expect(
        supplier.getProduct(setup.missingProductId),
      ).resolves.toBeNull();
      await expect(supplier.getOffer(setup.knownOfferId)).resolves.toEqual(
        expect.objectContaining({ supplierOfferId: setup.knownOfferId }),
      );
      await expect(supplier.getOffer(setup.missingOfferId)).resolves.toBeNull();
    });

    it("returns valid money, availability, and structured region evidence", async () => {
      const supplier = setup.createSupplier();
      const price = await supplier.getCurrentPrice(setup.knownOfferId);
      const offer = await supplier.getOffer(setup.knownOfferId);
      const evidence = await supplier.getRegionEvidence(setup.knownOfferId);
      const approvedAvailability: readonly Availability[] = [
        "IN_STOCK",
        "OUT_OF_STOCK",
        "LIMITED",
        "PREORDER",
        "UNKNOWN",
      ];

      expect(price.price).toEqual(
        money(price.price.amountMinor, currency(price.price.currency)),
      );
      expect(approvedAvailability).toContain(price.availability);
      expect(offer?.regionEvidence).toEqual(evidence);
      expect(validateRegionEvidence(evidence).decision).toBe("REVIEW_REQUIRED");
    });

    it("models purchase idempotency and conflicting reuse explicitly", async () => {
      const supplier = setup.createSupplier();
      const request = {
        clientIdempotencyReference: idempotencyKey("idem-contract"),
        correlationId: "corr-contract" as never,
        orderLineId: orderLineId("line-contract"),
        supplierOfferId: setup.knownOfferId,
      };
      const first = await supplier.submitPurchase(request);
      const repeat = await supplier.submitPurchase(request);

      expect(repeat).toEqual(first);
      await expect(
        supplier.submitPurchase({
          ...request,
          orderLineId: orderLineId("line-conflict"),
        }),
      ).rejects.toMatchObject({ category: "CONFLICT" });
    });

    it("represents delayed, unavailable, and reconciliation outcomes", async () => {
      const supplier = setup.createSupplier();
      const delayed = await supplier.submitPurchase({
        clientIdempotencyReference: idempotencyKey("idem-delayed"),
        correlationId: "corr-delayed" as never,
        orderLineId: orderLineId("line-delayed"),
        supplierOfferId: setup.delayedOfferId,
      });

      expect(delayed.state).toBe("DELAYED");
      await expect(
        supplier.submitPurchase({
          clientIdempotencyReference: idempotencyKey("idem-unavailable"),
          correlationId: "corr-unavailable" as never,
          orderLineId: orderLineId("line-unavailable"),
          supplierOfferId: setup.unavailableOfferId,
        }),
      ).rejects.toMatchObject({ category: "OUT_OF_STOCK" });
      await expect(
        supplier.reconcilePurchase(delayed.supplierPurchaseReference),
      ).resolves.toMatchObject({ outcome: "RESOLVED" });
    });

    it("matches optional key and refund behavior to capability declaration", async () => {
      const supplier = setup.createSupplier();
      const receipt = await supplier.submitPurchase({
        clientIdempotencyReference: idempotencyKey("idem-key-refund"),
        correlationId: "corr-key-refund" as never,
        orderLineId: orderLineId("line-key-refund"),
        supplierOfferId: setup.knownOfferId,
      });

      if (supplier.capabilities.supportsKeyRetrieval) {
        await expect(
          supplier.retrieveKey?.(receipt.supplierPurchaseReference),
        ).resolves.toMatchObject({
          supplierPurchaseReference: receipt.supplierPurchaseReference,
        });
      }

      if (supplier.capabilities.supportsRefundClaims) {
        const claim = await supplier.submitRefundClaim?.({
          correlationId: "corr-refund" as never,
          orderLineId: orderLineId("line-key-refund"),
          supplierPurchaseReference: receipt.supplierPurchaseReference,
        });
        const repeat = await supplier.submitRefundClaim?.({
          correlationId: "corr-refund" as never,
          orderLineId: orderLineId("line-key-refund"),
          supplierPurchaseReference: receipt.supplierPurchaseReference,
        });
        expect(repeat).toEqual(claim);
      }
    });

    it("returns approved health states and safe rate-limit metadata", async () => {
      const supplier = setup.createSupplier();
      const health = await supplier.getHealth();

      expect(["HEALTHY", "DEGRADED", "OUTAGE", "UNKNOWN"]).toContain(
        health.status,
      );
      if (health.rateLimit) {
        expect(health.rateLimit.remaining).toBeLessThanOrEqual(
          health.rateLimit.limit ?? Number.MAX_SAFE_INTEGER,
        );
      }
    });

    it("keeps errors and returned structures free of credentials", async () => {
      const supplier = setup.createSupplier();
      const result = await supplier.listCatalog({ limit: 10 });

      expect(JSON.stringify(result)).not.toMatch(
        /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|payment[_-]?credential)/iu,
      );
      await supplier
        .getCurrentPrice(setup.missingOfferId)
        .catch((error: unknown) => assertSafeSupplierError(error));
    });
  });
};

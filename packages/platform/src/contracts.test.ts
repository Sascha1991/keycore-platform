import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  correlationId,
  currency,
  emptyRegionEvidence,
  germanyCompatibilityDecisions,
  money,
  orderLineId,
  productId,
  supplierId,
  validateAuditMetadata,
  validateRegionEvidence,
  type OrderLineId,
  type ProductId,
} from "./contracts.js";

const sourceRoot = path.resolve("packages/platform/src");

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(fullPath);
      }

      return entry.isFile() && fullPath.endsWith(".ts") ? [fullPath] : [];
    }),
  );

  return files.flat();
}

describe("core contract value types", () => {
  it("rejects invalid money currency and amount combinations", () => {
    expect(() => currency("EUR")).not.toThrow();
    expect(() => currency("eur")).toThrow("Currency");
    expect(() => currency("EURO")).toThrow("Currency");
    expect(() => money(-1n, currency("EUR"))).toThrow("Money amount");
  });

  it("uses branded identifiers so unrelated identifiers cannot be assigned", () => {
    const typedProductId: ProductId = productId("product-1");
    const typedOrderLineId: OrderLineId = orderLineId("order-line-1");

    expect(typedProductId).toBe("product-1");
    expect(typedOrderLineId).toBe("order-line-1");

    // @ts-expect-error ProductId must not be assignable to OrderLineId.
    const confusedIdentifier: OrderLineId = typedProductId;
    expect(confusedIdentifier).toBe("product-1");
  });

  it("contains exactly the approved Germany compatibility decisions", () => {
    expect(germanyCompatibilityDecisions).toEqual([
      "ALLOWED",
      "BLOCKED",
      "REVIEW_REQUIRED",
      "DISABLED",
    ]);
  });

  it("fails safely for unknown or malformed region evidence", () => {
    expect(validateRegionEvidence(emptyRegionEvidence()).decision).toBe(
      "REVIEW_REQUIRED",
    );

    expect(
      validateRegionEvidence({
        activationRestrictions: [],
        allowedCountries: [],
        excludedCountries: [],
        hasContradictoryEvidence: true,
        hasMissingValues: false,
        hasUnknownValues: false,
        requiresForeignAccount: false,
        requiresVpn: false,
      }).decision,
    ).toBe("REVIEW_REQUIRED");
  });

  it("rejects forbidden audit metadata fields", () => {
    expect(() =>
      validateAuditMetadata({
        productKey: "redacted",
      }),
    ).toThrow("forbidden field");

    expect(
      validateAuditMetadata({
        reason: "safe",
      }),
    ).toEqual({ reason: "safe" });
  });
});

describe("core contract dependency boundaries", () => {
  it("keeps core modules free of forbidden adapter dependencies", async () => {
    const forbiddenPatterns = [
      /from\s+["'][^"']*(wordpress|woocommerce|kinguin|stripe|redis|pg|postgres|aws|gcp|google-cloud|azure|hashicorp|axios|fetch|node:http|node:https)[^"']*["']/i,
      /import\s+["'][^"']*(wordpress|woocommerce|kinguin|stripe|redis|pg|postgres|aws|gcp|google-cloud|azure|hashicorp|axios|fetch|node:http|node:https)[^"']*["']/i,
    ];

    const files = await listSourceFiles(sourceRoot);
    const findings: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          findings.push(path.relative(sourceRoot, file));
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("keeps supplier contracts supplier-neutral", async () => {
    const supplierContract = await readFile(
      path.join(sourceRoot, "ports/supplier.ts"),
      "utf8",
    );

    expect(supplierContract).not.toMatch(/kinguin/i);
  });

  it("does not expose unsafe key-vault or audit plaintext fields", async () => {
    const [corePorts, auditContract] = await Promise.all([
      readFile(path.join(sourceRoot, "ports/core.ts"), "utf8"),
      readFile(path.join(sourceRoot, "domain/audit.ts"), "utf8"),
    ]);

    expect(corePorts).not.toMatch(/plaintextKey|plaintext_key|log.*key/i);
    expect(auditContract).not.toMatch(/productKey|product_key/i);
  });

  it("exports neutral identifiers without runtime supplier assumptions", () => {
    expect(supplierId("supplier-neutral")).toBe("supplier-neutral");
    expect(correlationId("corr-1")).toBe("corr-1");
  });
});

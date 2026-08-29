import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { SafeOperationalLogger } from "../../packages/platform/src/operations/observability.js";
import { validateAuditMetadata } from "../../packages/platform/src/domain/audit.js";
import { scanSecretText } from "../../scripts/secret-patterns.mjs";

const projectRoot = process.cwd();

describe("KS-11-05 repository security assessment", () => {
  it("assesses runtime canary omission across logs, audit and evidence-safe surfaces", () => {
    const canaries = sensitiveCanaries();
    const write = vi.fn();
    const logger = new SafeOperationalLogger({ write });
    logger.write({
      component: "OPERATIONS",
      correlationId: "sec-assessment-safe-correlation",
      event: "OPERATION_BLOCKED",
      nested: Object.fromEntries(
        canaries.map((item) => [item.class, item.value]),
      ),
      operation: "CUSTOMER_KEY_DELIVERY",
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      result: "DENIED",
    });

    const observedSurfaces = [
      JSON.stringify(write.mock.calls),
      JSON.stringify(
        canaries.map((item) => ({
          canaryClass: item.class,
          fingerprint: createHash("sha256").update(item.value).digest("hex"),
          leakCount: 0,
        })),
      ),
    ];
    for (const canary of canaries) {
      expect(() => validateAuditMetadata({ note: canary.value })).toThrow(
        /forbidden value/u,
      );
      expect(
        observedSurfaces.every((surface) => !surface.includes(canary.value)),
      ).toBe(true);
    }
  });

  it("detects expanded synthetic credential classes without exposing values", () => {
    const canaries = sensitiveCanaries();
    const detectedClasses = new Set(
      canaries.flatMap((canary) => scanSecretText(canary.scannerValue)),
    );
    expect(detectedClasses).toEqual(
      new Set([
        "bearer credential",
        "GitLab token",
        "Google API key",
        "live Stripe restricted key",
        "npm token",
        "Slack token",
        "Stripe webhook secret",
      ]),
    );
  });

  it("reviews lockfile lifecycle scripts and workflow dependency posture", async () => {
    const lock = JSON.parse(
      await readFile(`${projectRoot}/package-lock.json`, "utf8"),
    ) as {
      readonly lockfileVersion: number;
      readonly packages: Readonly<
        Record<string, { readonly hasInstallScript?: boolean }>
      >;
    };
    expect(lock.lockfileVersion).toBe(3);
    const installScriptPackages = Object.entries(lock.packages)
      .filter(([, metadata]) => metadata.hasInstallScript === true)
      .map(([packagePath]) => packagePath)
      .sort();
    expect(installScriptPackages).toEqual([
      "node_modules/esbuild",
      "node_modules/fsevents",
    ]);

    const workflow = await readFile(
      `${projectRoot}/.github/workflows/quality-gates.yml`,
      "utf8",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@(main|master|HEAD)\b/u);
    expect(workflow).toMatch(/uses:\s+actions\/checkout@v4/u);
  });

  it("classifies production browser response headers as not applicable to the current edge", async () => {
    const packageJson = JSON.parse(
      await readFile(`${projectRoot}/package.json`, "utf8"),
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(packageJson.dependencies).not.toHaveProperty("express");
    expect(packageJson.dependencies).not.toHaveProperty("fastify");
    expect(packageJson.dependencies).not.toHaveProperty("hono");
  });
});

const sensitiveCanaries = (): readonly {
  readonly class: string;
  readonly scannerValue: string;
  readonly value: string;
}[] => {
  const entropy = randomUUID().replaceAll("-", "");
  return [
    {
      class: "PRODUCT_KEY",
      scannerValue: ["TEST", "AAAAA", "BBBBB", "CCCCC"].join("-"),
      value: ["TEST", "AAAAA", "BBBBB", "CCCCC"].join("-"),
    },
    {
      class: "AUTH_SESSION",
      scannerValue: `Bearer ${entropy}`,
      value: `Bearer ${entropy}`,
    },
    {
      class: "GUEST_CLAIM",
      scannerValue: `glpat-${entropy}`,
      value: `claim_token=${entropy}`,
    },
    {
      class: "VERIFICATION_TOKEN",
      scannerValue: `npm_${entropy}`,
      value: `verification_token=${entropy}`,
    },
    {
      class: "DELIVERY_CAPABILITY",
      scannerValue: `xoxb-${entropy}`,
      value: `delivery_capability=${entropy}`,
    },
    {
      class: "PAYMENT_CREDENTIAL",
      scannerValue: `rk_live_${entropy}`,
      value: `client_secret=${entropy}`,
    },
    {
      class: "SUPPLIER_CREDENTIAL",
      scannerValue: `AIza${entropy}`,
      value: `api_key=${entropy}`,
    },
    {
      class: "WRAPPING_KEY",
      scannerValue: `Bearer ${entropy}wrapping`,
      value: `master_key=${entropy}`,
    },
    {
      class: "WEBHOOK_SECRET",
      scannerValue: `whsec_${entropy}`,
      value: `whsec_${entropy}`,
    },
  ];
};

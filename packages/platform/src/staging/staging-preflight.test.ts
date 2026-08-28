import { describe, expect, it } from "vitest";

import { OperationalHealthService } from "../operations/observability.js";
import {
  StagingConfigurationHealthProbe,
  StagingPreflightService,
  loadStagingPreflightConfiguration,
  verifyStagingConfiguration,
} from "./staging-preflight.js";

const migrations = {
  appliedVersions: ["001", "002", "026"],
  expectedVersions: ["001", "002", "026"],
  reachable: true,
} as const;

describe("staging preflight", () => {
  it("accepts explicit isolated staging configuration without exposing secrets", () => {
    const env = safeEnvironment();
    const report = new StagingPreflightService().verify(
      loadStagingPreflightConfiguration(env),
      migrations,
    );

    expect(report).toMatchObject({
      deploymentId: "staging-ci-001",
      environment: "STAGING",
      status: "READY",
    });
    expect(report.checks.every((item) => item.status === "PASS")).toBe(true);
    const output = JSON.stringify(report);
    for (const marker of secretMarkers(env)) {
      expect(output).not.toContain(marker);
    }
  });

  it.each([undefined, "LOCAL", "TEST", "PRODUCTION", "staging"])(
    "rejects missing or invalid environment identity %s",
    (environment) => {
      const report = verify({ ...safeEnvironment(), KEYCORE_ENV: environment });
      expect(report.status).toBe("UNREADY");
      expect(reasonCodes(report)).toContain("STAGING_ENVIRONMENT_REQUIRED");
    },
  );

  it("rejects contradictory production database and Redis identities", () => {
    const report = verify({
      ...safeEnvironment(),
      KEYCORE_DATABASE_URL:
        "postgres://staging-user:database-canary@production-db.invalid/keycore",
      KEYCORE_POSTGRES_RESOURCE_ENV: "PRODUCTION",
      KEYCORE_REDIS_RESOURCE_ENV: "PRODUCTION",
      KEYCORE_REDIS_URL: "rediss://production-cache.invalid:6380",
    });

    expect(reasonCodes(report)).toEqual(
      expect.arrayContaining([
        "PRODUCTION_DATABASE_FORBIDDEN",
        "PRODUCTION_REDIS_FORBIDDEN",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("database-canary");
  });

  it("rejects Stripe live mode and never emits payment configuration", () => {
    const report = verify({
      ...safeEnvironment(),
      STRIPE_ENVIRONMENT: "LIVE",
      STRIPE_SECRET_KEY: `sk_${"live"}_STAGING_DO_NOT_USE_123456`,
    });
    expect(reasonCodes(report)).toContain("STRIPE_LIVE_MODE_FORBIDDEN");
    expect(JSON.stringify(report)).not.toContain("STAGING_DO_NOT_USE");
  });

  it("allows mock supplier and rejects production Kinguin configuration and control flags", () => {
    expect(verify(safeEnvironment()).status).toBe("READY");
    const report = verify({
      ...safeEnvironment(),
      KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL: "true",
      KEYCORE_STAGING_SUPPLIER_MODE: "KINGUIN_SANDBOX",
      KINGUIN_API_BASE_URL: "https://gateway.kinguin.net/esa/api",
      KINGUIN_ENVIRONMENT: "PRODUCTION",
    });
    expect(reasonCodes(report)).toEqual(
      expect.arrayContaining([
        "PRODUCTION_SUPPLIER_ENDPOINT_FORBIDDEN",
        "STAGING_SUPPLIER_CONFIGURATION_REQUIRED",
      ]),
    );
  });

  it("allows an explicit credentialed HTTPS supplier sandbox", () => {
    const report = verify({
      ...safeEnvironment(),
      KEYCORE_STAGING_SUPPLIER_MODE: "KINGUIN_SANDBOX",
      KINGUIN_API_BASE_URL: "https://sandbox-supplier.example.invalid/api",
      KINGUIN_API_KEY: "SYNTHETIC_SANDBOX_CREDENTIAL_CANARY",
      KINGUIN_ENVIRONMENT: "SANDBOX",
    });

    expect(report.status).toBe("READY");
    expect(JSON.stringify(report)).not.toContain("CREDENTIAL_CANARY");
  });

  it("rejects unrestricted mail and weakened browser transport", () => {
    const report = verify({
      ...safeEnvironment(),
      KEYCORE_CSRF_ENABLED: "false",
      KEYCORE_DEBUG: "true",
      KEYCORE_MAIL_ALLOW_EXTERNAL: "true",
      KEYCORE_STAGING_MAIL_MODE: "EXTERNAL",
      KEYCORE_STAGING_PUBLIC_ORIGIN: "http://staging.example.invalid",
      KEYCORE_SECURE_COOKIES: "false",
    });
    expect(reasonCodes(report)).toEqual(
      expect.arrayContaining([
        "UNSAFE_MAIL_TRANSPORT",
        "STAGING_ORIGIN_UNSAFE",
        "STAGING_TRANSPORT_SECURITY_REQUIRED",
      ]),
    );
  });

  it.each([
    "https://keyrano.de",
    "https://www.keyrano.de",
    "https://keyrano.com",
    "https://www.keyrano.com",
  ])(
    "classifies the current production storefront origin %s as production",
    (origin) => {
      const environment = {
        ...safeEnvironment(),
        KEYCORE_STAGING_PUBLIC_ORIGIN: origin,
      };

      expect(
        loadStagingPreflightConfiguration(environment).transport.origin,
      ).toBe("PRODUCTION");
      const report = verify(environment);
      expect(report.status).toBe("UNREADY");
      expect(reasonCodes(report)).toContain("STAGING_ORIGIN_UNSAFE");
    },
  );

  it("accepts only the canonical real staging origin and isolated CI origin", () => {
    for (const origin of [
      "https://staging.keyrano.de",
      "https://staging.example.invalid",
    ]) {
      const environment = {
        ...safeEnvironment(),
        KEYCORE_STAGING_PUBLIC_ORIGIN: origin,
      };
      expect(
        loadStagingPreflightConfiguration(environment).transport.origin,
      ).toBe("STAGING");
      expect(verify(environment).status).toBe("READY");
    }
  });

  it.each([
    "https://shop.example.com",
    "https://preview.keyrano.de",
    "https://user:password@staging.keyrano.de",
    "https://staging.keyrano.de/path",
  ])("rejects unapproved or malformed HTTPS origin %s", (origin) => {
    const environment = {
      ...safeEnvironment(),
      KEYCORE_STAGING_PUBLIC_ORIGIN: origin,
    };

    expect(
      loadStagingPreflightConfiguration(environment).transport.origin,
    ).toBe("INVALID");
    expect(reasonCodes(verify(environment))).toContain("STAGING_ORIGIN_UNSAFE");
  });

  it("fails closed on missing or mismatched migration state", () => {
    const config = loadStagingPreflightConfiguration(safeEnvironment());
    expect(reasonCodes(new StagingPreflightService().verify(config))).toContain(
      "MIGRATION_STATUS_REQUIRED",
    );
    expect(
      reasonCodes(
        new StagingPreflightService().verify(config, {
          appliedVersions: ["001", "025"],
          expectedVersions: ["001", "002", "026"],
          reachable: true,
        }),
      ),
    ).toContain("MIGRATION_MISMATCH");
  });

  it("keeps the connection guard limited to facts verified without PostgreSQL", () => {
    const report = verifyStagingConfiguration(
      loadStagingPreflightConfiguration(safeEnvironment()),
    );

    expect(report.status).toBe("READY");
    expect(report.checks.some((item) => item.component === "MIGRATIONS")).toBe(
      false,
    );
  });

  it("extends role-aware readiness without making staging config authoritative", async () => {
    const config = loadStagingPreflightConfiguration(safeEnvironment());
    const health = new OperationalHealthService([
      { dependency: "POSTGRESQL", check: async () => "HEALTHY" },
      { dependency: "REDIS", check: async () => "HEALTHY" },
      new StagingConfigurationHealthProbe(config, migrations),
    ]);
    await expect(health.check("STAGING_DEPLOYMENT")).resolves.toMatchObject({
      liveness: "ALIVE",
      readiness: "READY",
    });

    const unsafe = new OperationalHealthService([
      { dependency: "POSTGRESQL", check: async () => "HEALTHY" },
      { dependency: "REDIS", check: async () => "HEALTHY" },
      new StagingConfigurationHealthProbe(
        loadStagingPreflightConfiguration({
          ...safeEnvironment(),
          KEYCORE_ENV: "PRODUCTION",
        }),
        migrations,
      ),
    ]);
    await expect(unsafe.check("STAGING_DEPLOYMENT")).resolves.toMatchObject({
      liveness: "ALIVE",
      readiness: "UNREADY",
    });
    await expect(unsafe.check("READ_ONLY")).resolves.toMatchObject({
      readiness: "DEGRADED",
    });
  });
});

const verify = (env: Readonly<Record<string, string | undefined>>) =>
  new StagingPreflightService().verify(
    loadStagingPreflightConfiguration(env),
    migrations,
  );

const reasonCodes = (
  report: ReturnType<StagingPreflightService["verify"]>,
): readonly string[] =>
  report.checks.flatMap((item) =>
    item.status === "FAIL" && item.reasonCode ? [item.reasonCode] : [],
  );

const secretMarkers = (
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  [
    env.KEYCORE_DATABASE_URL,
    env.KEYCORE_REDIS_URL,
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.KEYCORE_FULFILLMENT_MASTER_KEY,
  ].filter((item): item is string => Boolean(item));

const safeEnvironment = (): Record<string, string | undefined> => ({
  KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL: "false",
  KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "false",
  KEYCORE_CSRF_ENABLED: "true",
  KEYCORE_DATABASE_URL:
    "postgres://staging-user:STAGING_DATABASE_CANARY@staging-db.invalid/keycore_staging",
  KEYCORE_DEBUG: "false",
  KEYCORE_DEPLOYMENT_ID: "staging-ci-001",
  KEYCORE_ENCRYPTION_RESOURCE_ENV: "STAGING",
  KEYCORE_ENV: "STAGING",
  KEYCORE_FULFILLMENT_MASTER_KEY: "STAGING_MASTER_KEY_CANARY_DO_NOT_USE",
  KEYCORE_FULFILLMENT_MASTER_KEY_ID: "staging-fulfillment-v1",
  KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE: "",
  KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE: "",
  KEYCORE_MAIL_ALLOW_EXTERNAL: "false",
  KEYCORE_OPERATIONS_AUTHORITY_MODE: "DISABLED",
  KEYCORE_POSTGRES_RESOURCE_ENV: "STAGING",
  KEYCORE_POSTGRES_RESOURCE_ID: "staging-postgres-primary",
  KEYCORE_REDIS_NAMESPACE: "keycore:staging:staging-ci-001",
  KEYCORE_REDIS_RESOURCE_ENV: "STAGING",
  KEYCORE_REDIS_RESOURCE_ID: "staging-redis-primary",
  KEYCORE_REDIS_URL:
    "rediss://staging-user:STAGING_REDIS_CANARY@staging-cache.invalid:6380",
  KEYCORE_SECURE_COOKIES: "true",
  KEYCORE_STAGING_MAIL_MODE: "CAPTURE",
  KEYCORE_STAGING_PUBLIC_ORIGIN: "https://staging.example.invalid",
  KEYCORE_STAGING_SUPPLIER_MODE: "MOCK",
  STRIPE_ENVIRONMENT: "TEST",
  STRIPE_SECRET_KEY: "sk_test_STAGING_STRIPE_CANARY_DO_NOT_USE",
  STRIPE_WEBHOOK_SECRET: "whsec_STAGING_WEBHOOK_CANARY_DO_NOT_USE",
});

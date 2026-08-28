import type {
  DependencyHealth,
  HealthProbe,
} from "../operations/observability.js";

export type DeploymentEnvironment = "LOCAL" | "TEST" | "STAGING" | "PRODUCTION";

export type StagingPreflightReasonCode =
  | "STAGING_ENVIRONMENT_REQUIRED"
  | "STAGING_DEPLOYMENT_ID_REQUIRED"
  | "PRODUCTION_DATABASE_FORBIDDEN"
  | "STAGING_DATABASE_REQUIRED"
  | "PRODUCTION_REDIS_FORBIDDEN"
  | "STAGING_REDIS_REQUIRED"
  | "REDIS_NAMESPACE_UNSAFE"
  | "STRIPE_LIVE_MODE_FORBIDDEN"
  | "STRIPE_TEST_CONFIGURATION_REQUIRED"
  | "PRODUCTION_SUPPLIER_ENDPOINT_FORBIDDEN"
  | "STAGING_SUPPLIER_CONFIGURATION_REQUIRED"
  | "UNSAFE_MAIL_TRANSPORT"
  | "STAGING_ORIGIN_UNSAFE"
  | "STAGING_TRANSPORT_SECURITY_REQUIRED"
  | "STAGING_ENCRYPTION_ISOLATION_REQUIRED"
  | "PRODUCTION_OPERATIONS_AUTHORITY_FORBIDDEN"
  | "POSTGRES_UNAVAILABLE"
  | "MIGRATION_STATUS_REQUIRED"
  | "MIGRATION_MISMATCH";

type ResourceClassification = "INVALID" | "MISSING" | "PRODUCTION" | "STAGING";
type SupplierMode =
  "KINGUIN_PRODUCTION" | "KINGUIN_SANDBOX" | "MOCK" | "UNKNOWN";

export interface StagingPreflightConfiguration {
  readonly environment?: string | undefined;
  readonly deploymentId?: string | undefined;
  readonly postgres: {
    readonly classification: ResourceClassification;
    readonly resourceEnvironment?: string | undefined;
    readonly resourceId?: string | undefined;
  };
  readonly redis: {
    readonly classification: ResourceClassification;
    readonly namespace?: string | undefined;
    readonly resourceEnvironment?: string | undefined;
    readonly resourceId?: string | undefined;
  };
  readonly stripe: {
    readonly environment?: string | undefined;
    readonly secretMode: "LIVE" | "MISSING" | "TEST" | "UNKNOWN";
    readonly webhookSecretConfigured: boolean;
  };
  readonly supplier: {
    readonly mode: SupplierMode;
    readonly endpoint: ResourceClassification;
    readonly credentialConfigured: boolean;
    readonly controlledProductionFlagsDisabled: boolean;
  };
  readonly mail: {
    readonly mode?: string | undefined;
    readonly externalDeliveryEnabled: boolean;
  };
  readonly transport: {
    readonly origin: ResourceClassification;
    readonly csrfEnabled: boolean;
    readonly debugDisabled: boolean;
    readonly secureCookies: boolean;
  };
  readonly encryption: {
    readonly resourceEnvironment?: string | undefined;
    readonly resourceId?: string | undefined;
    readonly keyConfigured: boolean;
  };
  readonly operationsAuthorityMode?: string | undefined;
}

export interface StagingMigrationStatus {
  readonly expectedVersions: readonly string[];
  readonly appliedVersions: readonly string[];
  readonly reachable: boolean;
}

export interface StagingPreflightCheck {
  readonly component:
    | "DATABASE"
    | "ENCRYPTION"
    | "ENVIRONMENT"
    | "MAIL"
    | "MIGRATIONS"
    | "OPERATIONS_AUTHORITY"
    | "REDIS"
    | "STRIPE"
    | "SUPPLIER"
    | "TRANSPORT";
  readonly status: "PASS" | "FAIL";
  readonly reasonCode?: StagingPreflightReasonCode;
}

export interface StagingPreflightReport {
  readonly status: "READY" | "UNREADY";
  readonly environment: "STAGING" | null;
  readonly deploymentId: string | null;
  readonly checks: readonly StagingPreflightCheck[];
}

export class StagingPreflightService {
  public verify(
    configuration: StagingPreflightConfiguration,
    migrations?: StagingMigrationStatus,
  ): StagingPreflightReport {
    const checks: StagingPreflightCheck[] = [];
    check(
      checks,
      "ENVIRONMENT",
      configuration.environment === "STAGING",
      "STAGING_ENVIRONMENT_REQUIRED",
    );
    check(
      checks,
      "ENVIRONMENT",
      safeDeploymentId(configuration.deploymentId),
      "STAGING_DEPLOYMENT_ID_REQUIRED",
    );
    checkResource(
      checks,
      "DATABASE",
      configuration.postgres.classification,
      configuration.postgres.resourceEnvironment,
      configuration.postgres.resourceId,
      "PRODUCTION_DATABASE_FORBIDDEN",
      "STAGING_DATABASE_REQUIRED",
    );
    checkResource(
      checks,
      "REDIS",
      configuration.redis.classification,
      configuration.redis.resourceEnvironment,
      configuration.redis.resourceId,
      "PRODUCTION_REDIS_FORBIDDEN",
      "STAGING_REDIS_REQUIRED",
    );
    check(
      checks,
      "REDIS",
      configuration.redis.namespace ===
        `keycore:staging:${configuration.deploymentId ?? ""}`,
      "REDIS_NAMESPACE_UNSAFE",
    );
    check(
      checks,
      "STRIPE",
      configuration.stripe.environment !== "LIVE" &&
        configuration.stripe.secretMode !== "LIVE",
      "STRIPE_LIVE_MODE_FORBIDDEN",
    );
    check(
      checks,
      "STRIPE",
      configuration.stripe.environment === "TEST" &&
        configuration.stripe.secretMode === "TEST" &&
        configuration.stripe.webhookSecretConfigured,
      "STRIPE_TEST_CONFIGURATION_REQUIRED",
    );
    check(
      checks,
      "SUPPLIER",
      configuration.supplier.mode !== "KINGUIN_PRODUCTION" &&
        configuration.supplier.endpoint !== "PRODUCTION",
      "PRODUCTION_SUPPLIER_ENDPOINT_FORBIDDEN",
    );
    check(
      checks,
      "SUPPLIER",
      configuration.supplier.controlledProductionFlagsDisabled &&
        (configuration.supplier.mode === "MOCK" ||
          (configuration.supplier.mode === "KINGUIN_SANDBOX" &&
            configuration.supplier.endpoint === "STAGING" &&
            configuration.supplier.credentialConfigured)),
      "STAGING_SUPPLIER_CONFIGURATION_REQUIRED",
    );
    check(
      checks,
      "MAIL",
      configuration.mail.mode === "CAPTURE" &&
        !configuration.mail.externalDeliveryEnabled,
      "UNSAFE_MAIL_TRANSPORT",
    );
    check(
      checks,
      "TRANSPORT",
      configuration.transport.origin === "STAGING",
      "STAGING_ORIGIN_UNSAFE",
    );
    check(
      checks,
      "TRANSPORT",
      configuration.transport.secureCookies &&
        configuration.transport.csrfEnabled &&
        configuration.transport.debugDisabled,
      "STAGING_TRANSPORT_SECURITY_REQUIRED",
    );
    check(
      checks,
      "ENCRYPTION",
      configuration.encryption.resourceEnvironment === "STAGING" &&
        safeStagingResourceId(configuration.encryption.resourceId) &&
        configuration.encryption.keyConfigured,
      "STAGING_ENCRYPTION_ISOLATION_REQUIRED",
    );
    check(
      checks,
      "OPERATIONS_AUTHORITY",
      configuration.operationsAuthorityMode === "DISABLED",
      "PRODUCTION_OPERATIONS_AUTHORITY_FORBIDDEN",
    );
    if (!migrations) {
      check(checks, "MIGRATIONS", false, "MIGRATION_STATUS_REQUIRED");
    } else if (!migrations.reachable) {
      check(checks, "MIGRATIONS", false, "POSTGRES_UNAVAILABLE");
    } else {
      check(
        checks,
        "MIGRATIONS",
        arraysEqual(migrations.appliedVersions, migrations.expectedVersions),
        "MIGRATION_MISMATCH",
      );
    }
    const deploymentId = safeDeploymentId(configuration.deploymentId)
      ? configuration.deploymentId
      : null;
    return Object.freeze({
      checks: Object.freeze(checks.map((item) => Object.freeze(item))),
      deploymentId,
      environment: configuration.environment === "STAGING" ? "STAGING" : null,
      status: checks.some((item) => item.status === "FAIL")
        ? "UNREADY"
        : "READY",
    });
  }
}

export const verifyStagingConfiguration = (
  configuration: StagingPreflightConfiguration,
): StagingPreflightReport => {
  const fullReport = new StagingPreflightService().verify(configuration);
  const checks = fullReport.checks.filter(
    (item) => item.component !== "MIGRATIONS",
  );
  return Object.freeze({
    ...fullReport,
    checks: Object.freeze(checks),
    status: checks.some((item) => item.status === "FAIL") ? "UNREADY" : "READY",
  });
};

export const loadStagingPreflightConfiguration = (
  env: Readonly<Record<string, string | undefined>>,
): StagingPreflightConfiguration => ({
  deploymentId: env.KEYCORE_DEPLOYMENT_ID,
  encryption: {
    keyConfigured: Boolean(env.KEYCORE_FULFILLMENT_MASTER_KEY),
    resourceEnvironment: env.KEYCORE_ENCRYPTION_RESOURCE_ENV,
    resourceId: env.KEYCORE_FULFILLMENT_MASTER_KEY_ID,
  },
  environment: env.KEYCORE_ENV,
  mail: {
    externalDeliveryEnabled: env.KEYCORE_MAIL_ALLOW_EXTERNAL === "true",
    mode: env.KEYCORE_STAGING_MAIL_MODE,
  },
  operationsAuthorityMode: env.KEYCORE_OPERATIONS_AUTHORITY_MODE,
  postgres: {
    classification: classifyUrl(
      env.KEYCORE_DATABASE_URL,
      ["postgres:", "postgresql:"],
      ["prod", "production"],
    ),
    resourceEnvironment: env.KEYCORE_POSTGRES_RESOURCE_ENV,
    resourceId: env.KEYCORE_POSTGRES_RESOURCE_ID,
  },
  redis: {
    classification: classifyUrl(
      env.KEYCORE_REDIS_URL,
      ["redis:", "rediss:"],
      ["prod", "production"],
    ),
    namespace: env.KEYCORE_REDIS_NAMESPACE,
    resourceEnvironment: env.KEYCORE_REDIS_RESOURCE_ENV,
    resourceId: env.KEYCORE_REDIS_RESOURCE_ID,
  },
  stripe: {
    environment: env.STRIPE_ENVIRONMENT,
    secretMode: classifyStripeSecret(env.STRIPE_SECRET_KEY),
    webhookSecretConfigured: Boolean(
      env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"),
    ),
  },
  supplier: {
    controlledProductionFlagsDisabled: [
      env.KEYCORE_ALLOW_KINGUIN_LIVE_READONLY,
      env.KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL,
      env.KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE,
      env.KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE,
    ].every((value) => !value || value === "false"),
    credentialConfigured: Boolean(env.KINGUIN_API_KEY),
    endpoint: classifySupplierEndpoint(env.KINGUIN_API_BASE_URL),
    mode: classifySupplierMode(env),
  },
  transport: {
    csrfEnabled: env.KEYCORE_CSRF_ENABLED === "true",
    debugDisabled: env.KEYCORE_DEBUG === "false",
    origin: classifyOrigin(env.KEYCORE_STAGING_PUBLIC_ORIGIN),
    secureCookies: env.KEYCORE_SECURE_COOKIES === "true",
  },
});

export class StagingConfigurationHealthProbe implements HealthProbe {
  public readonly dependency = "STAGING_CONFIGURATION" as const;

  public constructor(
    private readonly configuration: StagingPreflightConfiguration,
    private readonly migrations: StagingMigrationStatus,
  ) {}

  public async check(): Promise<DependencyHealth> {
    return new StagingPreflightService().verify(
      this.configuration,
      this.migrations,
    ).status === "READY"
      ? "HEALTHY"
      : "UNAVAILABLE";
  }
}

const checkResource = (
  checks: StagingPreflightCheck[],
  component: "DATABASE" | "REDIS",
  classification: ResourceClassification,
  environment: string | undefined,
  resourceId: string | undefined,
  productionCode: StagingPreflightReasonCode,
  missingCode: StagingPreflightReasonCode,
): void => {
  check(
    checks,
    component,
    classification !== "PRODUCTION" && environment !== "PRODUCTION",
    productionCode,
  );
  check(
    checks,
    component,
    classification === "STAGING" &&
      environment === "STAGING" &&
      safeStagingResourceId(resourceId),
    missingCode,
  );
};

const check = (
  checks: StagingPreflightCheck[],
  component: StagingPreflightCheck["component"],
  passed: boolean,
  reasonCode: StagingPreflightReasonCode,
): void => {
  checks.push(
    passed
      ? { component, status: "PASS" }
      : { component, reasonCode, status: "FAIL" },
  );
};

const safeDeploymentId = (value: string | undefined): value is string =>
  Boolean(value && /^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(value));

const safeStagingResourceId = (value: string | undefined): value is string =>
  Boolean(value && /^staging-[a-z0-9][a-z0-9-]{2,95}$/u.test(value));

const arraysEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const classifyUrl = (
  raw: string | undefined,
  protocols: readonly string[],
  forbiddenTokens: readonly string[],
): ResourceClassification => {
  if (!raw) return "MISSING";
  try {
    const url = new URL(raw);
    if (!protocols.includes(url.protocol)) return "INVALID";
    const identity = `${url.hostname}/${url.pathname}`.toLowerCase();
    return forbiddenTokens.some((token) => identity.includes(token))
      ? "PRODUCTION"
      : "STAGING";
  } catch {
    return "INVALID";
  }
};

const classifyStripeSecret = (
  value: string | undefined,
): StagingPreflightConfiguration["stripe"]["secretMode"] =>
  !value
    ? "MISSING"
    : value.startsWith("sk_live_")
      ? "LIVE"
      : value.startsWith("sk_test_")
        ? "TEST"
        : "UNKNOWN";

const classifySupplierMode = (
  env: Readonly<Record<string, string | undefined>>,
): SupplierMode => {
  if (
    env.KEYCORE_STAGING_SUPPLIER_MODE === "MOCK" &&
    (!env.KINGUIN_ENVIRONMENT || env.KINGUIN_ENVIRONMENT === "SANDBOX")
  ) {
    return "MOCK";
  }
  if (
    env.KEYCORE_STAGING_SUPPLIER_MODE === "KINGUIN_SANDBOX" &&
    env.KINGUIN_ENVIRONMENT === "SANDBOX"
  ) {
    return "KINGUIN_SANDBOX";
  }
  return env.KINGUIN_ENVIRONMENT === "PRODUCTION"
    ? "KINGUIN_PRODUCTION"
    : "UNKNOWN";
};

const classifySupplierEndpoint = (
  raw: string | undefined,
): ResourceClassification => {
  if (!raw) return "MISSING";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "INVALID";
    return url.hostname.toLowerCase() === "gateway.kinguin.net"
      ? "PRODUCTION"
      : "STAGING";
  } catch {
    return "INVALID";
  }
};

const classifyOrigin = (raw: string | undefined): ResourceClassification => {
  if (!raw) return "MISSING";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      return "INVALID";
    }
    const origin = url.origin.toLowerCase();
    if (productionStorefrontOrigins.has(origin)) return "PRODUCTION";
    if (url.pathname !== "/" || url.search || url.hash) return "INVALID";
    return approvedStagingOrigins.has(origin) ? "STAGING" : "INVALID";
  } catch {
    return "INVALID";
  }
};

const productionStorefrontOrigins = new Set([
  "https://keyrano.de",
  "https://www.keyrano.de",
  "https://keyrano.com",
  "https://www.keyrano.com",
]);

const approvedStagingOrigins = new Set([
  "https://staging.keyrano.de",
  "https://staging.example.invalid",
]);

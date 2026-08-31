import { createServer } from "node:http";

import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import { PostgresCustomerAccountReadRepository } from "../infra/postgres/customer-account-repositories.js";
import { seedSyntheticStagingCheckoutData } from "../infra/postgres/staging-checkout-seed.js";
import { createPostgresStagingCheckout } from "../infra/storefront/staging-checkout.js";
import {
  createStagingStorefrontRuntime,
  handleStagingHttpRequest,
} from "../infra/storefront/staging-storefront-runtime.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

if (process.env.KEYCORE_ENV !== "STAGING") {
  throw new Error("STAGING_STOREFRONT_ENVIRONMENT_REQUIRED");
}

const databasePool = createPostgresPool({
  connectionString: internalDatabaseUrl(
    required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
  ),
});
const runtime = await createStagingStorefrontRuntime(
  {
    allowedOrigin: required("KEYRANO_STAGING_ORIGIN"),
    customerAWpUserId: required("KEYRANO_STAGING_CUSTOMER_A_WP_USER_ID"),
    customerBWpUserId: required("KEYRANO_STAGING_CUSTOMER_B_WP_USER_ID"),
    masterKeyMaterialBase64: required("KEYRANO_STAGING_BROWSER_MASTER_KEY"),
    sharedSecret: required("KEYRANO_STAGING_BRIDGE_SECRET"),
    syntheticKey: required("KEYRANO_STAGING_SYNTHETIC_KEY"),
  },
  await dependencies(),
);

const port = Number.parseInt(
  process.env.KEYRANO_STAGING_BRIDGE_PORT ?? "3000",
  10,
);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("KEYRANO_STAGING_BRIDGE_PORT_INVALID");
}

const server = createServer((request, response) => {
  void handleStagingHttpRequest(runtime.bridge, request, response).catch(() => {
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    response.end('{"status":"ERROR","code":"TEMPORARILY_UNAVAILABLE"}');
  });
}).listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void databasePool.end().finally(() => process.exit(0));
    });
  });
}

async function dependencies() {
  const database = new PostgresTransactionBoundary(databasePool);
  await seedSyntheticStagingCheckoutData(database, {
    deploymentId: process.env.KEYCORE_DEPLOYMENT_ID,
    environment: process.env.KEYCORE_ENV,
  });
  return {
    accountRepository: new PostgresCustomerAccountReadRepository(database),
    checkout: createPostgresStagingCheckout(database),
  };
}

function internalDatabaseUrl(password: string): string {
  const url = new URL(
    "postgresql://keycore_staging@postgres:5432/keycore_staging",
  );
  url.password = password;
  return url.toString();
}

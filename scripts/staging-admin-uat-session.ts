import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import {
  assertStagingAdminUatEnvironment,
  issueStagingAdminUatSession,
  serializeStagingAdminUatSessionResult,
} from "./staging-admin-uat-session-service.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const environment = {
  deploymentId: process.env.KEYCORE_DEPLOYMENT_ID,
  enabled: process.env.KEYRANO_STAGING_ADMIN_UAT_SESSION_ENABLED,
  environment: process.env.KEYCORE_ENV,
  origin: process.env.KEYRANO_STAGING_ADMIN_ORIGIN,
};
assertStagingAdminUatEnvironment(environment);

const pool = createPostgresPool({
  connectionString: internalDatabaseUrl(
    required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
  ),
});
const database = new PostgresTransactionBoundary(pool);

try {
  const result = await issueStagingAdminUatSession(database, {
    adminId: required("KEYRANO_STAGING_ADMIN_UAT_TARGET_ID"),
    environment,
    hashSecret: required("KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET"),
    rawSession: required("KEYRANO_STAGING_ADMIN_UAT_SESSION_CODE"),
  });
  process.stdout.write(`${serializeStagingAdminUatSessionResult(result)}\n`);
} finally {
  await pool.end();
}

function internalDatabaseUrl(password: string): string {
  const url = new URL(
    "postgresql://keycore_staging@postgres:5432/keycore_staging",
  );
  url.password = password;
  return url.toString();
}

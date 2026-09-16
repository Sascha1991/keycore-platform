import { randomUUID } from "node:crypto";

import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import {
  bootstrapStagingAdmin,
  parseStagingAdminRole,
} from "./staging-admin-bootstrap-service.js";
import {
  hashAdminPassword,
  normalizeAdminEmail,
} from "../packages/platform/src/contracts.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

if (process.env.KEYCORE_ENV !== "STAGING") {
  throw new Error("STAGING_ADMIN_ENVIRONMENT_REQUIRED");
}

const rawSession = required("KEYRANO_STAGING_ADMIN_SESSION_CODE");
if (rawSession.length < 32)
  throw new Error("STAGING_ADMIN_SESSION_CODE_TOO_SHORT");
const hashSecret = required("KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET");
const role = parseStagingAdminRole(process.env.KEYRANO_STAGING_ADMIN_ROLE);
const emailNormalized = normalizeAdminEmail(
  required("KEYRANO_STAGING_ADMIN_LOGIN_EMAIL"),
);
if (!emailNormalized) throw new Error("STAGING_ADMIN_LOGIN_EMAIL_INVALID");
const passwordHash = await hashAdminPassword(
  required("KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD"),
);
const rotateExisting =
  process.env.KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE === "true";
if (
  process.env.KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE !== undefined &&
  !["true", "false"].includes(
    process.env.KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE,
  )
) {
  throw new Error("STAGING_ADMIN_LOGIN_PASSWORD_ROTATE_INVALID");
}
const databaseUrl = internalDatabaseUrl(
  required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
);
const pool = createPostgresPool({ connectionString: databaseUrl });
const database = new PostgresTransactionBoundary(pool);

try {
  const result = await bootstrapStagingAdmin(database, {
    hashSecret,
    rawSession,
    role,
    credential: { emailNormalized, passwordHash, rotateExisting },
  });
  process.stdout.write(
    `${JSON.stringify({ adminId: result.adminId, expiresAt: result.expiresAt.toISOString(), role: result.role, status: "READY", bootstrapRunId: randomUUID() })}\n`,
  );
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

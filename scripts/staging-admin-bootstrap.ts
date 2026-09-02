import { randomUUID } from "node:crypto";

import { hashAdminSession } from "../packages/platform/src/contracts.js";
import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";

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
const databaseUrl = internalDatabaseUrl(
  required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
);
const pool = createPostgresPool({ connectionString: databaseUrl });
const database = new PostgresTransactionBoundary(pool);
const adminId = "a1000000-0000-4000-8000-000000000001";
const sessionId = "a2000000-0000-4000-8000-000000000001";
const now = new Date();
const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);

try {
  await database.transaction(async (client) => {
    await client.query(
      `
        INSERT INTO admin_identities(
          id, provider, provider_subject, display_name, status, created_at, updated_at
        )
        VALUES ($1, 'STAGING_SYNTHETIC', 'keyrano-staging-project-owner', 'Staging Project Owner', 'ACTIVE', $2, $2)
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          status = 'ACTIVE',
          updated_at = EXCLUDED.updated_at
      `,
      [adminId, now],
    );
    await client.query(
      `
        INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at)
        SELECT $1, 'PROJECT_OWNER', 'staging-bootstrap', $2
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_role_assignments
          WHERE admin_id = $1 AND role = 'PROJECT_OWNER' AND revoked_at IS NULL
        )
      `,
      [adminId, now],
    );
    await client.query("DELETE FROM admin_sessions WHERE admin_id = $1", [
      adminId,
    ]);
    await client.query(
      `
        INSERT INTO admin_sessions(
          id, admin_id, session_hash, assurance, issued_at, expires_at
        )
        VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)
      `,
      [
        sessionId,
        adminId,
        hashAdminSession(rawSession, hashSecret),
        now,
        expiresAt,
      ],
    );
  });
  process.stdout.write(
    `${JSON.stringify({ adminId, expiresAt: expiresAt.toISOString(), status: "READY", bootstrapRunId: randomUUID() })}\n`,
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

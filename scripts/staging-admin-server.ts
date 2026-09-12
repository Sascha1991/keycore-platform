import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";

import {
  AdminAuthenticationService,
  AdminPasswordAuthenticationService,
  AdminPasswordResetService,
  AdminOperationsService,
  AdminOrderService,
  AdminStaffService,
} from "../packages/platform/src/contracts.js";
import { AdminHttpController } from "../infra/admin/admin-http.js";
import { AdminOperationsControlMutation } from "../infra/admin/admin-operations-control.js";
import { AdminSupportOperations } from "../infra/admin/admin-support-operations.js";
import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import {
  PostgresAdminOrderReadRepository,
  PostgresAdminPasswordCredentialRepository,
  PostgresAdminPasswordResetRepository,
  PostgresAdminSessionRepository,
  PostgresAdminStaffRepository,
} from "../infra/postgres/admin-repositories.js";
import { PostgresAdminOperationsRepository } from "../infra/postgres/admin-operations-repository.js";
import { PostgresOperationsControlRepository } from "../infra/postgres/operations-control-repositories.js";
import { PostgresSupportCaseRepository } from "../infra/postgres/support-case-repositories.js";
import { PostgresAuditEventRepository } from "../infra/postgres/repositories.js";
import { inspectStagingMigrationStatus } from "../infra/postgres/staging-preflight.js";
import { PostgresStagingDelayedFulfillment } from "../infra/storefront/staging-delayed-fulfillment.js";
import { MailpitStagingTransport } from "../infra/storefront/staging-mailpit.js";
import {
  StagingPreflightService,
  loadStagingPreflightConfiguration,
} from "../packages/platform/src/staging/staging-preflight.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

if (process.env.KEYCORE_ENV !== "STAGING")
  throw new Error("STAGING_ADMIN_ENVIRONMENT_REQUIRED");
const allowedOrigin = required("KEYRANO_STAGING_ADMIN_ORIGIN");
const secureCookies = parseSecureCookiePolicy(
  allowedOrigin,
  required("KEYRANO_STAGING_ADMIN_SECURE_COOKIES"),
);
const pool = createPostgresPool({
  connectionString: internalDatabaseUrl(
    required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
  ),
});
const database = new PostgresTransactionBoundary(pool);
const audit = new PostgresAuditEventRepository(database);
const preflightEnvironment = {
  ...process.env,
  KEYCORE_DATABASE_URL: internalDatabaseUrl(
    required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
  ),
  KEYCORE_REDIS_URL: internalRedisUrl(
    required("KEYCORE_STAGING_REDIS_PASSWORD"),
  ),
};
const preflight = new StagingPreflightService().verify(
  loadStagingPreflightConfiguration(preflightEnvironment),
  await inspectStagingMigrationStatus(
    preflightEnvironment.KEYCORE_DATABASE_URL,
  ),
);
const mailpit = new MailpitStagingTransport(
  required("KEYCORE_STAGING_MAILPIT_URL"),
  allowedOrigin,
);
const delayedFulfillment =
  preflight.status === "READY"
    ? new PostgresStagingDelayedFulfillment({
        database,
        masterKeyMaterialBase64: required("KEYCORE_FULFILLMENT_MASTER_KEY"),
        masterKeyVersion: required("KEYCORE_FULFILLMENT_MASTER_KEY_ID"),
        notification: mailpit,
        syntheticKey: required("KEYRANO_STAGING_SYNTHETIC_KEY"),
      })
    : undefined;
const controller = new AdminHttpController(
  new AdminAuthenticationService(
    new PostgresAdminSessionRepository(database),
    audit,
    required("KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET"),
    "STAGING",
  ),
  new AdminPasswordAuthenticationService(
    new PostgresAdminPasswordCredentialRepository(database),
    audit,
    required("KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET"),
    "STAGING",
  ),
  new AdminPasswordResetService(
    new PostgresAdminPasswordResetRepository(database),
    mailpit,
    audit,
    "STAGING",
  ),
  new AdminOrderService(
    new PostgresAdminOrderReadRepository(database),
    audit,
    required("KEYRANO_STAGING_ADMIN_CURSOR_SECRET"),
    "STAGING",
  ),
  new AdminStaffService(
    new PostgresAdminStaffRepository(database),
    audit,
    required("KEYRANO_STAGING_ADMIN_CURSOR_SECRET"),
    "STAGING",
  ),
  {
    allowedOrigin,
    csrfSecret: required("KEYRANO_STAGING_ADMIN_CSRF_SECRET"),
    secureCookies,
  },
  delayedFulfillment,
  new AdminOperationsService(
    new PostgresAdminOperationsRepository(database),
    audit,
    required("KEYRANO_STAGING_ADMIN_CURSOR_SECRET"),
    "STAGING",
    undefined,
    new AdminOperationsControlMutation(
      new PostgresOperationsControlRepository(database),
      audit,
      "STAGING",
    ),
    new AdminSupportOperations(
      new PostgresSupportCaseRepository(database),
      audit,
      "STAGING",
    ),
  ),
);
const css = await readFile(
  new URL("../apps/admin/assets/admin.css", import.meta.url),
  "utf8",
);
const port = parsePort(process.env.KEYRANO_STAGING_ADMIN_PORT ?? "3001");

const server = createServer((request, response) => {
  void handle(request)
    .then((result) => {
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    })
    .catch(() => {
      response.writeHead(503, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Admin service unavailable");
    });
}).listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => void pool.end().finally(() => process.exit(0))),
  );
}

async function handle(request: IncomingMessage) {
  const url = new URL(request.url ?? "/", allowedOrigin);
  if (request.method === "GET" && url.pathname === "/health") {
    return {
      body: '{"status":"UP"}',
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
      statusCode: 200,
    };
  }
  if (request.method === "GET" && url.pathname === "/admin/assets/admin.css") {
    return {
      body: css,
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "text/css; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
      statusCode: 200,
    };
  }
  const body =
    request.method === "POST" ? await readBoundedBody(request, 4096) : "";
  return controller.handle({
    form: new URLSearchParams(body),
    headers: {
      cookie: header(request, "cookie"),
      origin: header(request, "origin"),
    },
    method: request.method ?? "",
    path: url.pathname,
    query: url.searchParams,
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("ADMIN_REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSecureCookiePolicy(origin: string, value: string): boolean {
  if (value !== "true" && value !== "false")
    throw new Error("STAGING_ADMIN_SECURE_COOKIES_INVALID");
  const parsed = new URL(origin);
  if (parsed.username || parsed.password)
    throw new Error("STAGING_ADMIN_ORIGIN_CREDENTIALS_FORBIDDEN");
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (value === "false" && !localHttp)
    throw new Error("STAGING_ADMIN_SECURE_COOKIES_REQUIRED");
  if (parsed.protocol !== "https:" && !localHttp)
    throw new Error("STAGING_ADMIN_HTTPS_REQUIRED");
  return value === "true";
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("STAGING_ADMIN_PORT_INVALID");
  return port;
}

function internalDatabaseUrl(password: string): string {
  const url = new URL(
    "postgresql://keycore_staging@postgres:5432/keycore_staging",
  );
  url.password = password;
  return url.toString();
}

function internalRedisUrl(password: string): string {
  const url = new URL("redis://redis:6379");
  url.password = password;
  return url.toString();
}

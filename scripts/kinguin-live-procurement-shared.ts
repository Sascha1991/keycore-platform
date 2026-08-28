import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresControlledProcurementApprovalRepository } from "../infra/postgres/controlled-procurement-repositories.js";
import { PostgresOperationsControlRepository } from "../infra/postgres/operations-control-repositories.js";
import { createControlledLiveServiceFromEnv } from "../infra/suppliers/kinguin/kinguin-controlled-live-procurement.js";
import { OperationsControlService } from "../packages/platform/src/operations/operations-controls.js";

export const loadLocalEnv = (): Readonly<
  Record<string, string | undefined>
> => {
  const loaded: Record<string, string | undefined> = { ...process.env };
  try {
    const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/gu, "");
      loaded[key] ??= value;
    }
  } catch {
    // Local .env is optional and intentionally ignored by Git.
  }
  return loaded;
};

export const serviceFromEnv = async (
  env: Readonly<Record<string, string | undefined>>,
  mode: "READ_ONLY" | "CONTROLLED_MUTATION",
) => {
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  const db = new PostgresTransactionBoundary(pool);
  const repository = new PostgresControlledProcurementApprovalRepository(db);
  const operationsControlGate = new OperationsControlService(
    new PostgresOperationsControlRepository(db),
  );
  const service = createControlledLiveServiceFromEnv({
    env,
    mode,
    operationsControlGate,
    repository,
  });
  return { pool, service };
};

export const argValue = (
  args: readonly string[],
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

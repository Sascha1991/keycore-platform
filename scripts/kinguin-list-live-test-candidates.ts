import { SupplierError } from "../packages/platform/src/contracts.js";
import {
  argValue,
  loadLocalEnv,
  serviceFromEnv,
} from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const env = loadLocalEnv();
  const input = parseCandidateListArgs(process.argv.slice(2));
  const { pool, service } = await serviceFromEnv(env, "READ_ONLY");
  try {
    const result = await service.listCandidates(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
};

export const parseCandidateListArgs = (
  args: readonly string[],
): {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxCandidates?: number;
  readonly startPage?: number;
} => {
  const maxCandidates = optionalPositiveIntegerArg(args, "--max-candidates");
  const maxPages = optionalPositiveIntegerArg(args, "--max-pages");
  const pageSize = optionalPositiveIntegerArg(args, "--page-size");
  const startPage = optionalPositiveIntegerArg(args, "--start-page");
  return {
    ...(maxCandidates !== undefined ? { maxCandidates } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(startPage !== undefined ? { startPage } : {}),
  };
};

export const optionalPositiveIntegerArg = (
  args: readonly string[],
  name: string,
): number | undefined => {
  const value = argValue(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`Invalid ${name}: expected a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}: expected a safe positive integer`);
  }
  return parsed;
};

if (process.argv[1]?.endsWith("kinguin-list-live-test-candidates.ts")) {
  main().catch((error: unknown) => {
    if (error instanceof SupplierError) {
      process.stderr.write(
        `${JSON.stringify(
          {
            category: error.category,
            operation: error.context.operation,
            supplierId: error.context.supplierId,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "FAILED"}\n`,
      );
    }
    process.exitCode = 1;
  });
}

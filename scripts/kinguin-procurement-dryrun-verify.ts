import { readFile } from "node:fs/promises";

import { SupplierError } from "../packages/platform/src/contracts.js";
import { runKinguinProcurementDryRunVerification } from "../infra/suppliers/kinguin/kinguin-procurement-dryrun.js";

const parseDotEnvLine = (
  line: string,
): readonly [string, string] | undefined => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  const key = trimmed
    .slice(0, separator)
    .trim()
    .replace(/^export\s+/u, "");
  let value = trimmed.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
};

const loadLocalEnv = async (): Promise<Record<string, string | undefined>> => {
  const loaded: Record<string, string | undefined> = { ...process.env };
  try {
    const dotEnv = await readFile(".env", "utf8");
    for (const line of dotEnv.split(/\r?\n/u)) {
      const parsed = parseDotEnvLine(line);
      if (parsed) {
        const [key, value] = parsed;
        loaded[key] = value;
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return loaded;
};

const main = async (): Promise<void> => {
  const result = await runKinguinProcurementDryRunVerification(
    await loadLocalEnv(),
  );
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error: unknown) => {
  if (error instanceof SupplierError) {
    console.error(
      JSON.stringify({
        category: error.category,
        operation: error.context.operation,
        supplierId: error.context.supplierId,
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.error("Kinguin procurement dry-run verification failed.");
  process.exitCode = 1;
});

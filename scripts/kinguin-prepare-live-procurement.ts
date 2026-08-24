import {
  SupplierError,
  correlationId,
  currency,
  money,
  supplierOfferId,
  supplierProductId,
} from "../packages/platform/src/contracts.js";
import {
  argValue,
  loadLocalEnv,
  serviceFromEnv,
} from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const env = loadLocalEnv();
  const args = process.argv.slice(2);
  const product = argValue(args, "--product-id");
  const offer = argValue(args, "--offer-id");
  const maxMinor = argValue(args, "--max-minor");
  if (!product || !offer || !maxMinor) {
    throw new Error(
      "Usage: npm run kinguin:prepare-live-procurement -- --product-id <id> --offer-id <id> --max-minor <EUR minor units>",
    );
  }
  const parsedMax = BigInt(maxMinor);
  const { pool, service } = await serviceFromEnv(env);
  try {
    const result = await service.prepare({
      correlationId: correlationId("controlled-live-prepare"),
      maximumAcquisitionAmount: money(parsedMax, currency("EUR")),
      quantity: 1,
      supplierOfferId: supplierOfferId(offer),
      supplierProductId: supplierProductId(product),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
};

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

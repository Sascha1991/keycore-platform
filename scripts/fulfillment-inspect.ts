import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresFulfillmentRepository } from "../infra/postgres/fulfillment-repositories.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [fulfillmentId] = process.argv.slice(2);
  if (!fulfillmentId) {
    throw new Error("Usage: npm run fulfillment:inspect -- <fulfillmentId>");
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const repository = new PostgresFulfillmentRepository(
      new PostgresTransactionBoundary(pool),
    );
    const operation = await repository.findById(fulfillmentId);
    if (!operation) {
      throw new Error("FULFILLMENT_NOT_FOUND");
    }
    const secret = await repository.findSecretByFulfillmentId(fulfillmentId);
    process.stdout.write(
      `${JSON.stringify(
        {
          createdAt: operation.createdAt.toISOString(),
          deliveredAt: operation.deliveredAt?.toISOString() ?? null,
          deliveryState: operation.deliveryState,
          encryptionKeyId: secret?.encryptionKeyId ?? null,
          encryptionVersion: secret?.encryptionVersion ?? null,
          externalSupplierOrderId: operation.externalSupplierOrderId,
          fulfillmentId: operation.id,
          hasEncryptedSecret: Boolean(secret),
          retrievedAt: operation.retrievedAt?.toISOString() ?? null,
          retrievalState: operation.retrievalState,
          status: operation.status,
          supplier: operation.supplierId,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "FAILED"}\n`,
  );
  process.exitCode = 1;
});

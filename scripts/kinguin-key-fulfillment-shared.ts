import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresControlledProcurementApprovalRepository } from "../infra/postgres/controlled-procurement-repositories.js";
import { PostgresFulfillmentRepository } from "../infra/postgres/fulfillment-repositories.js";
import { PostgresOperationsControlRepository } from "../infra/postgres/operations-control-repositories.js";
import { ControlledProcurementFulfillmentEvidence } from "../infra/fulfillment/controlled-procurement-evidence.js";
import {
  fulfillmentConfigFromEnv,
  validateControlledKeyRetrievalConfig,
} from "../infra/fulfillment/fulfillment-config.js";
import { EnvSecretProvider } from "../infra/suppliers/kinguin/kinguin-live-readonly.js";
import { validateControlledReadOnlyConfig } from "../infra/suppliers/kinguin/kinguin-controlled-live-procurement.js";
import {
  KinguinControlledKeyRetrievalTransport,
  KinguinKeyRetrievalAdapter,
} from "../infra/suppliers/kinguin/kinguin-key-retrieval.js";
import {
  FetchKinguinHttpTransport,
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
} from "../infra/suppliers/kinguin/kinguin-supplier.js";
import {
  type CorrelationId,
  OperationsControlService,
  SecureKeyFulfillmentService,
  type SupplierId,
  type SupplierKeyRetrievalPort,
} from "../packages/platform/src/contracts.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

class PrepareOnlyKeyRetrieval implements SupplierKeyRetrievalPort {
  public async retrievePurchasedKeys(_input: {
    readonly supplierId: SupplierId;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }): ReturnType<SupplierKeyRetrievalPort["retrievePurchasedKeys"]> {
    void _input;
    throw new Error("KEY_RETRIEVAL_NOT_CONFIGURED_FOR_PREPARE");
  }
}

export const fulfillmentServiceFromEnv = async (
  env: Readonly<Record<string, string | undefined>>,
  mode: "PREPARE" | "EXECUTE",
) => {
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const fulfillmentConfig =
    mode === "EXECUTE"
      ? validateControlledKeyRetrievalConfig(env)
      : fulfillmentConfigFromEnv(env);
  const pool = createPostgresPool({ connectionString });
  const db = new PostgresTransactionBoundary(pool);
  const approvals = new PostgresControlledProcurementApprovalRepository(db);
  const repository = new PostgresFulfillmentRepository(db);
  const operationsControlGate = new OperationsControlService(
    new PostgresOperationsControlRepository(db),
  );
  const keyRetrieval =
    mode === "EXECUTE"
      ? kinguinKeyRetrievalFromEnv(env, fulfillmentConfig.keyRetrievalTimeoutMs)
      : new PrepareOnlyKeyRetrieval();
  const service = new SecureKeyFulfillmentService({
    approvalTtlMs: fulfillmentConfig.approvalTtlMs,
    controlledKeyRetrievalEnabled:
      fulfillmentConfig.controlledKeyRetrievalEnabled,
    controlledKeyRetrievalMode: fulfillmentConfig.controlledKeyRetrievalMode,
    keyManagementProvider: fulfillmentConfig.keyManagementProvider,
    keyRetrieval,
    operationsControlGate,
    procurementEvidence: new ControlledProcurementFulfillmentEvidence(
      approvals,
    ),
    repository,
    retrievalLeaseStaleAfterMs: fulfillmentConfig.retrievalLeaseStaleAfterMs,
  });
  return { pool, repository, service };
};

const kinguinKeyRetrievalFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): SupplierKeyRetrievalPort => {
  const supplierConfig = {
    ...validateControlledReadOnlyConfig(env),
    timeoutMs,
  };
  const keyGuard = new KinguinControlledKeyRetrievalTransport({
    baseUrl: supplierConfig.baseUrl,
    delegate: new FetchKinguinHttpTransport(),
  });
  const supplier = new KinguinSupplier(
    new KinguinHttpClient(supplierConfig, new EnvSecretProvider(env), {
      send: (request) => keyGuard.retrieveKeys(request),
    }),
    new InMemoryKinguinOfferProductIndex(),
  );
  return new KinguinKeyRetrievalAdapter(supplier);
};

export { loadLocalEnv };

import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  CustomerAccountService,
  ProductKeyVaultService,
  correlationId,
  currency,
  customerId,
  money,
  orderId,
  orderLineId,
  type AuditEvent,
  type AuditEventPort,
  type CustomerAccountOrderProjection,
  type CustomerId,
  type KeyAccessAuthorizationPort,
} from "../../packages/platform/src/contracts.js";
import { InMemoryCustomerAccountReadRepository } from "../customers/in-memory-customer-account-repository.js";
import { DevelopmentKeyManagementProvider } from "../key-management/development-provider.js";
import { InMemoryEncryptedKeyRepository } from "../vault/in-memory-encrypted-key-repository.js";
import {
  StagingStorefrontBridge,
  type StagingStorefrontRequest,
} from "./staging-browser-adapter.js";

export const stagingCustomerAId = customerId(
  "10000000-0000-4000-8000-000000000001",
);
export const stagingCustomerBId = customerId(
  "10000000-0000-4000-8000-000000000002",
);
export const stagingFulfilledOrderId = orderId(
  "20000000-0000-4000-8000-000000000001",
);
export const stagingPendingOrderId = orderId(
  "20000000-0000-4000-8000-000000000002",
);
export const stagingCustomerBOrderId = orderId(
  "20000000-0000-4000-8000-000000000003",
);
const stagingFulfilledOrderLineId = orderLineId(
  "30000000-0000-4000-8000-000000000001",
);
const stagingFulfillmentId = "40000000-0000-4000-8000-000000000001";
const fixtureNow = new Date("2026-08-30T10:00:00.000Z");

export interface StagingStorefrontRuntimeConfig {
  readonly sharedSecret: string;
  readonly allowedOrigin: string;
  readonly masterKeyMaterialBase64: string;
  readonly syntheticKey: string;
  readonly customerAWpUserId: string;
  readonly customerBWpUserId: string;
  readonly now?: () => Date;
}

export interface StagingStorefrontRuntime {
  readonly bridge: StagingStorefrontBridge;
  readonly auditEvents: readonly AuditEvent[];
}

export const createStagingStorefrontRuntime = async (
  config: StagingStorefrontRuntimeConfig,
): Promise<StagingStorefrontRuntime> => {
  if (
    !config.syntheticKey.startsWith("SYNTHETIC_") ||
    config.syntheticKey.length > 128
  ) {
    throw new Error("A bounded synthetic reveal fixture is required");
  }
  const repository = new InMemoryCustomerAccountReadRepository();
  repository.addAccount({
    createdAt: fixtureNow,
    customerId: stagingCustomerAId,
    emailMasked: "k********a@example.test",
    emailVerificationState: "VERIFIED",
  });
  repository.addAccount({
    createdAt: fixtureNow,
    customerId: stagingCustomerBId,
    emailMasked: "k********b@example.test",
    emailVerificationState: "VERIFIED",
  });
  repository.addOrder(fulfilledOrder(stagingCustomerAId));
  repository.addOrder(pendingOrder(stagingCustomerAId));
  repository.addOrder(otherCustomerOrder(stagingCustomerBId));

  const audit = new MemoryAudit();
  const keyRepository = new InMemoryEncryptedKeyRepository();
  const authorization = new StagingVaultAuthorization(
    new Map([[stagingFulfilledOrderLineId, stagingCustomerAId]]),
  );
  const vault = new ProductKeyVaultService(
    keyRepository,
    new DevelopmentKeyManagementProvider({
      environmentName: "staging",
      masterKeyMaterialBase64: config.masterKeyMaterialBase64,
      masterKeyVersion: "staging-browser-synthetic-v1",
    }),
    authorization,
    audit,
    "STAGING",
  );
  const source = Buffer.from(config.syntheticKey, "utf8");
  try {
    await vault.storeReceivedKey({
      actor: { id: "staging-fixture-loader", type: "SYSTEM" },
      correlationId: correlationId("staging-synthetic-fixture-load"),
      orderLineId: stagingFulfilledOrderLineId,
      receivedSecretMaterial: source,
    });
  } finally {
    source.fill(0);
  }

  return {
    auditEvents: audit.events,
    bridge: new StagingStorefrontBridge({
      accountService: new CustomerAccountService({
        audit,
        cursorSigningSecret: config.sharedSecret,
        environment: "STAGING",
        ...(config.now ? { now: config.now } : {}),
        repository,
      }),
      allowedOrigin: config.allowedOrigin,
      identityMappings: new Map([
        [config.customerAWpUserId, stagingCustomerAId],
        [config.customerBWpUserId, stagingCustomerBId],
      ]),
      ...(config.now ? { now: config.now } : {}),
      orderLines: new Map([
        [
          stagingFulfilledOrderId,
          {
            customerId: stagingCustomerAId,
            orderLineId: stagingFulfilledOrderLineId,
          },
        ],
      ]),
      sharedSecret: config.sharedSecret,
      vaultService: vault,
    }),
  };
};

export const handleStagingHttpRequest = async (
  bridge: StagingStorefrontBridge,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"UP"}');
    return;
  }
  const body = await readBoundedBody(request, 4096);
  const storefrontRequest: StagingStorefrontRequest = {
    body,
    csrfVerified: header(request.headers, "x-keyrano-csrf-verified") === "1",
    customerId: optionalHeader(request.headers, "x-keyrano-customer-id"),
    method: request.method ?? "",
    origin: header(request.headers, "x-keyrano-origin"),
    path: request.url?.split("?", 1)[0] ?? "/",
    remoteAddress: request.socket.remoteAddress,
    signature: header(request.headers, "x-keyrano-signature"),
    timestamp: header(request.headers, "x-keyrano-timestamp"),
    wpUserId: optionalHeader(request.headers, "x-keyrano-wp-user-id"),
  };
  const result = await bridge.handle(storefrontRequest);
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
};

const fulfilledOrder = (owner: CustomerId): CustomerAccountOrderProjection => ({
  activation: {
    instructionCode: "STEAM_STANDARD",
    platform: "STEAM",
    source: "STRUCTURED",
  },
  createdAt: fixtureNow,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: {
    deliveredAt: null,
    deliveryState: "PENDING",
    fulfillmentId: stagingFulfillmentId,
    hasEncryptedSecret: true,
    orderId: stagingFulfilledOrderId,
    retrievedAt: fixtureNow,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  },
  fulfillmentStatus: "PENDING",
  invoice: {
    downloadAvailable: true,
    invoiceReference: "KR-SYNTHETIC-0001",
    issuedAt: fixtureNow,
    status: "AVAILABLE",
  },
  orderId: stagingFulfilledOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Neonpfad: Berlin",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(1299n, currency("EUR")),
  updatedAt: fixtureNow,
});

const pendingOrder = (owner: CustomerId): CustomerAccountOrderProjection => ({
  createdAt: fixtureNow,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: null,
  fulfillmentStatus: "PENDING",
  invoice: { downloadAvailable: false, status: "PENDING" },
  orderId: stagingPendingOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "PENDING",
  productTitle: "Orbital Tactics",
  refundStatus: "NOT_REQUESTED",
  status: "PAYMENT_CAPTURED",
  total: money(1899n, currency("EUR")),
  updatedAt: fixtureNow,
});

const otherCustomerOrder = (
  owner: CustomerId,
): CustomerAccountOrderProjection => ({
  ...pendingOrder(owner),
  orderId: stagingCustomerBOrderId,
  productTitle: "Lumen Grid",
});

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class StagingVaultAuthorization implements KeyAccessAuthorizationPort {
  public constructor(
    private readonly owners: ReadonlyMap<string, CustomerId>,
  ) {}
  public async authorizeReveal(input: {
    readonly actor: { readonly id: string; readonly type: string };
    readonly customerId?: CustomerId;
    readonly orderLineId: ReturnType<typeof orderLineId>;
  }) {
    const owner = this.owners.get(input.orderLineId);
    return owner &&
      input.actor.type === "CUSTOMER" &&
      input.customerId === owner &&
      input.actor.id === owner
      ? { allowed: true, reasonCode: "EXACT_OWNER_AUTHORIZED" }
      : { allowed: false, reasonCode: "RESOURCE_NOT_AVAILABLE" };
  }
}

const readBoundedBody = async (
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw as Uint8Array);
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const header = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  return typeof value === "string" ? value : "";
};

const optionalHeader = (
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined => {
  const value = header(headers, name);
  return value || undefined;
};

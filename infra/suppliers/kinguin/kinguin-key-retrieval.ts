import {
  SupplierError,
  type CorrelationId,
  type FulfillmentReasonCode,
  type RetrievedSupplierKey,
  type SupplierId,
  type SupplierKeyRetrievalPort,
} from "../../../packages/platform/src/contracts.js";
import type {
  KinguinHttpRequest,
  KinguinHttpResponse,
  KinguinHttpTransport,
  KinguinKey,
  KinguinSupplier,
} from "./kinguin-supplier.js";

const allowedKeyTypes = [
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/gif",
] as const;

export class KinguinKeyRetrievalAdapter implements SupplierKeyRetrievalPort {
  public constructor(private readonly supplier: KinguinSupplier) {}

  public async retrievePurchasedKeys(input: {
    readonly supplierId: SupplierId;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "RETRIEVED";
        readonly keys: readonly RetrievedSupplierKey[];
      }
    | { readonly status: "PENDING"; readonly reasonCode: FulfillmentReasonCode }
  > {
    if (input.supplierId !== this.supplier.identity.supplierId) {
      throw new SupplierError({
        category: "UNSUPPORTED_CAPABILITY",
        operation: "retrievePurchasedKeys",
        supplierId: input.supplierId,
      });
    }
    const keys = await this.supplier.downloadKeys(
      input.externalSupplierOrderId,
      {
        limit: 100,
        page: 1,
      },
    );
    if (keys.length === 0) {
      return {
        reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET",
        status: "PENDING",
      };
    }
    return {
      keys: keys.map(normalizeKinguinKey),
      status: "RETRIEVED",
    };
  }
}

export class KinguinControlledKeyRetrievalTransport {
  public constructor(
    private readonly input: {
      readonly baseUrl: string;
      readonly delegate: KinguinHttpTransport;
    },
  ) {}

  public async retrieveKeys(
    request: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    const url = new URL(request.path);
    const base = new URL(this.input.baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/u, "");
    const escapedBase = base.pathname.replace(/\/+$/u, "");
    const relativePath = normalizedPath.startsWith(escapedBase)
      ? normalizedPath.slice(escapedBase.length)
      : normalizedPath;
    if (
      request.method !== "GET" ||
      url.protocol !== "https:" ||
      url.host !== "gateway.kinguin.net" ||
      base.protocol !== "https:" ||
      base.host !== "gateway.kinguin.net" ||
      !/^\/v2\/order\/[^/]+\/keys$/u.test(relativePath) ||
      relativePath.includes("/return")
    ) {
      throw new SupplierError({
        category: "REJECTED",
        operation: "controlledKeyRetrievalGuard",
        supplierId: this.supplierId,
      });
    }
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      !Number.isFinite(request.timeoutMs)
    ) {
      throw new SupplierError({
        category: "REJECTED",
        operation: "controlledKeyRetrievalTimeout",
        supplierId: this.supplierId,
      });
    }
    const response = await this.input.delegate.send(request);
    if (response.status >= 300 && response.status < 400) {
      throw new SupplierError({
        category: "REJECTED",
        operation: "controlledKeyRetrievalRedirect",
        supplierId: this.supplierId,
      });
    }
    return response;
  }

  private get supplierId(): SupplierId {
    return "kinguin" as SupplierId;
  }
}

const normalizeKinguinKey = (key: KinguinKey): RetrievedSupplierKey => {
  if (
    !key.id ||
    !key.serial ||
    !allowedKeyTypes.includes(key.type as (typeof allowedKeyTypes)[number])
  ) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "retrievePurchasedKeys",
      supplierId: "kinguin" as SupplierId,
    });
  }
  return {
    contentType: key.type as RetrievedSupplierKey["contentType"],
    material:
      key.type === "text/plain"
        ? Buffer.from(key.serial, "utf8")
        : Buffer.from(key.serial, "base64"),
    supplierKeyId: key.id,
  };
};

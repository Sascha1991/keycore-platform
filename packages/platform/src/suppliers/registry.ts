import type {
  SupplierCapabilities,
  SupplierIdentity,
  SupplierPort,
} from "../ports/supplier.js";
import type { SupplierId } from "../domain/identifiers.js";
import { SupplierError } from "./errors.js";

export interface RegisteredSupplier {
  readonly identity: SupplierIdentity;
  readonly capabilities: SupplierCapabilities;
}

export class SupplierRegistry {
  private readonly suppliers = new Map<SupplierId, SupplierPort>();

  public register(supplier: SupplierPort): void {
    const supplierId = supplier.identity.supplierId;
    if (this.suppliers.has(supplierId)) {
      throw new SupplierError({
        category: "CONFLICT",
        operation: "registerSupplier",
        supplierId,
      });
    }

    this.suppliers.set(supplierId, supplier);
  }

  public resolve(supplierId: SupplierId): SupplierPort {
    const supplier = this.suppliers.get(supplierId);
    if (!supplier) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation: "resolveSupplier",
        supplierId,
      });
    }

    return supplier;
  }

  public list(): readonly RegisteredSupplier[] {
    return [...this.suppliers.values()]
      .map((supplier) => ({
        capabilities: supplier.capabilities,
        identity: supplier.identity,
      }))
      .sort((left, right) =>
        left.identity.supplierId.localeCompare(right.identity.supplierId),
      );
  }
}

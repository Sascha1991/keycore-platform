import { randomUUID } from "node:crypto";

import type {
  EncryptedKeyMaterial,
  EncryptedKeyRepository,
  OrderLineId,
  StoredEncryptedKeyRecord,
} from "../../packages/platform/src/contracts.js";

export class InMemoryEncryptedKeyRepository implements EncryptedKeyRepository {
  public readonly records = new Map<string, StoredEncryptedKeyRecord>();

  public async store(input: {
    readonly orderLineId: OrderLineId;
    readonly material: EncryptedKeyMaterial;
  }): Promise<StoredEncryptedKeyRecord> {
    if (await this.findActiveByOrderLineId(input.orderLineId)) {
      throw new Error("Encrypted key record already exists");
    }
    const record: StoredEncryptedKeyRecord = {
      ...input.material,
      createdAt: new Date(),
      id: randomUUID(),
      orderLineId: input.orderLineId,
      retiredAt: null,
      rotatedAt: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  public async findById(id: string): Promise<StoredEncryptedKeyRecord | null> {
    return this.records.get(id) ?? null;
  }

  public async findActiveByOrderLineId(
    id: OrderLineId,
  ): Promise<StoredEncryptedKeyRecord | null> {
    return (
      [...this.records.values()].find(
        (record) => record.orderLineId === id && record.retiredAt === null,
      ) ?? null
    );
  }

  public async rewrap(
    id: string,
    input: {
      readonly wrappedDataEncryptionKey: Uint8Array;
      readonly keyVersion: string;
      readonly rotatedAt: Date;
    },
  ): Promise<StoredEncryptedKeyRecord> {
    const current = this.records.get(id);
    if (!current || current.retiredAt !== null) {
      throw new Error("Encrypted key record rewrap failed");
    }
    const updated = { ...current, ...input };
    this.records.set(id, updated);
    return updated;
  }

  public async retire(id: string, retiredAt: Date): Promise<void> {
    const current = this.records.get(id);
    if (current) this.records.set(id, { ...current, retiredAt });
  }
}

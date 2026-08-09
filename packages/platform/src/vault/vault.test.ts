import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  correlationId,
  customerId,
  keyRecordId,
  orderLineId,
  validateSafePayload,
  type AuditEvent,
  type AuditEventPort,
  type EncryptedKeyMaterial,
  type EncryptedKeyRepository,
  type KeyAccessAuthorizationPort,
  type KeyAccessContext,
  type KeyManagementProvider,
  type StoredEncryptedKeyRecord,
} from "../contracts.js";
import {
  decryptProductKeyMaterial,
  encryptProductKeyMaterial,
  rewrapDataEncryptionKey,
} from "./crypto.js";
import { ProductKeyVaultService } from "./service.js";

class InMemoryEncryptedKeyRepository implements EncryptedKeyRepository {
  public readonly records = new Map<string, StoredEncryptedKeyRecord>();

  public async store(request: {
    readonly orderLineId: StoredEncryptedKeyRecord["orderLineId"];
    readonly material: EncryptedKeyMaterial;
  }): Promise<StoredEncryptedKeyRecord> {
    if (await this.findActiveByOrderLineId(request.orderLineId)) {
      throw new Error("Encrypted key record already exists");
    }

    const record: StoredEncryptedKeyRecord = {
      ...request.material,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: randomUUID(),
      orderLineId: request.orderLineId,
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
    id: StoredEncryptedKeyRecord["orderLineId"],
  ): Promise<StoredEncryptedKeyRecord | null> {
    return (
      [...this.records.values()].find(
        (record) => record.orderLineId === id && record.retiredAt === null,
      ) ?? null
    );
  }

  public async rewrap(
    id: string,
    request: {
      readonly wrappedDataEncryptionKey: Uint8Array;
      readonly keyVersion: string;
      readonly rotatedAt: Date;
    },
  ): Promise<StoredEncryptedKeyRecord> {
    const record = this.records.get(id);
    if (!record || record.retiredAt !== null) {
      throw new Error("Encrypted key record rewrap failed");
    }

    const updated = {
      ...record,
      keyVersion: request.keyVersion,
      rotatedAt: request.rotatedAt,
      wrappedDataEncryptionKey: request.wrappedDataEncryptionKey,
    };
    this.records.set(id, updated);
    return updated;
  }

  public async retire(id: string, retiredAt: Date): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, { ...record, retiredAt });
    }
  }
}

class MemoryWrappingProvider implements KeyManagementProvider {
  private get mask(): number {
    return this.version.endsWith("2") ? 0x5a : 0xa5;
  }

  public readonly unwrapDataKey = vi.fn(
    async (request: {
      readonly wrappedDataKey: Uint8Array;
      readonly keyVersion: string;
    }): Promise<Uint8Array> => {
      if (request.keyVersion !== this.version) {
        throw new Error("Wrapped data key version is unavailable");
      }

      return Buffer.from(request.wrappedDataKey).map(
        (value) => value ^ this.mask,
      );
    },
  );

  public constructor(public readonly version: string) {}

  public async activeMasterKeyVersion(): Promise<string> {
    return this.version;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }): Promise<{
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }> {
    return {
      keyVersion: this.version,
      wrappedDataKey: Buffer.from(request.dataKey).map(
        (value) => value ^ this.mask,
      ),
    };
  }

  public async getKeyVersionMetadata(
    keyVersion: string,
  ): Promise<Readonly<Record<string, string>>> {
    return { provider: "memory", version: keyVersion };
  }
}

class CapturingAuditPort implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const generatedSecret = (): Uint8Array =>
  Buffer.from(`synthetic-canary-${randomUUID()}`, "utf8");

const accessContext = (): KeyAccessContext => ({
  actor: { id: `customer-${randomUUID()}`, type: "CUSTOMER" },
  correlationId: correlationId(`corr-${randomUUID()}`),
  customerId: customerId(`customer-${randomUUID()}`),
  orderLineId: orderLineId(randomUUID()),
  reasonCode: "AUTHORIZED_TEST_REVEAL",
});

const authorization = (allowed: boolean): KeyAccessAuthorizationPort => ({
  authorizeReveal: vi.fn().mockResolvedValue({
    allowed,
    reasonCode: allowed ? "AUTHORIZED" : "NOT_AUTHORIZED",
  }),
});

const asText = (value: Uint8Array): string =>
  Buffer.from(value).toString("utf8");

describe("secure product-key vault cryptography", () => {
  it("round-trips with authenticated encryption", async () => {
    const provider = new MemoryWrappingProvider("mk-v1");
    const secret = generatedSecret();
    const material = await encryptProductKeyMaterial(secret, provider);

    await expect(
      decryptProductKeyMaterial(material, provider),
    ).resolves.toEqual(secret);
  });

  it("stores the same secret twice with different ciphertext and wrapping material", async () => {
    const provider = new MemoryWrappingProvider("mk-v1");
    const secret = generatedSecret();
    const first = await encryptProductKeyMaterial(secret, provider);
    const second = await encryptProductKeyMaterial(secret, provider);

    expect(
      Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext)),
    ).toBe(false);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(
      false,
    );
    expect(
      Buffer.from(first.wrappedDataEncryptionKey).equals(
        Buffer.from(second.wrappedDataEncryptionKey),
      ),
    ).toBe(false);
  });

  it("fails closed on tampered ciphertext, tag, nonce, and wrapped DEK", async () => {
    const provider = new MemoryWrappingProvider("mk-v1");
    const material = await encryptProductKeyMaterial(
      generatedSecret(),
      provider,
    );
    const tamper = (value: Uint8Array): Uint8Array => {
      const copy = Buffer.from(value);
      copy[0] = (copy[0] ?? 0) ^ 0xff;
      return copy;
    };

    await expect(
      decryptProductKeyMaterial(
        { ...material, ciphertext: tamper(material.ciphertext) },
        provider,
      ),
    ).rejects.toThrow("verification failed");
    await expect(
      decryptProductKeyMaterial(
        { ...material, authenticationTag: tamper(material.authenticationTag) },
        provider,
      ),
    ).rejects.toThrow("verification failed");
    await expect(
      decryptProductKeyMaterial(
        { ...material, nonce: tamper(material.nonce) },
        provider,
      ),
    ).rejects.toThrow("verification failed");
    await expect(
      decryptProductKeyMaterial(
        {
          ...material,
          wrappedDataEncryptionKey: tamper(material.wrappedDataEncryptionKey),
        },
        provider,
      ),
    ).rejects.toThrow("verification failed");
  });

  it("rewraps the DEK without changing product-key ciphertext", async () => {
    const oldProvider = new MemoryWrappingProvider("mk-v1");
    const newProvider = new MemoryWrappingProvider("mk-v2");
    const material = await encryptProductKeyMaterial(
      generatedSecret(),
      oldProvider,
    );

    const rewrapped = await rewrapDataEncryptionKey(
      material,
      oldProvider,
      newProvider,
    );

    expect(rewrapped.keyVersion).toBe("mk-v2");
    expect(
      Buffer.from(rewrapped.wrappedDataEncryptionKey).equals(
        Buffer.from(material.wrappedDataEncryptionKey),
      ),
    ).toBe(false);
    await expect(
      decryptProductKeyMaterial({ ...material, ...rewrapped }, newProvider),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("secure product-key vault service", () => {
  it("reveals only after explicit authorization and audits safe metadata", async () => {
    const repository = new InMemoryEncryptedKeyRepository();
    const audit = new CapturingAuditPort();
    const provider = new MemoryWrappingProvider("mk-v1");
    const context = accessContext();
    const vault = new ProductKeyVaultService(
      repository,
      provider,
      authorization(true),
      audit,
      "CI",
    );
    const secret = generatedSecret();

    const recordId = await vault.storeReceivedKey({
      correlationId: context.correlationId,
      orderLineId: context.orderLineId,
      receivedSecretMaterial: secret,
    });
    const revealed = await vault.retrieveForAuthorizedReveal(context);

    expect(recordId).toEqual(expect.any(String));
    expect(revealed).toEqual(secret);
    expect(audit.events.map((event) => event.eventType)).toEqual([
      "KEY_STORED",
      "KEY_REVEALED",
    ]);
    expect(JSON.stringify(audit.events)).not.toContain(asText(secret));
  });

  it("denies unauthorized reveal before decrypting", async () => {
    const repository = new InMemoryEncryptedKeyRepository();
    const audit = new CapturingAuditPort();
    const provider = new MemoryWrappingProvider("mk-v1");
    const context = accessContext();
    const vault = new ProductKeyVaultService(
      repository,
      provider,
      authorization(false),
      audit,
      "CI",
    );

    await vault.storeReceivedKey({
      correlationId: context.correlationId,
      orderLineId: context.orderLineId,
      receivedSecretMaterial: generatedSecret(),
    });

    await expect(vault.retrieveForAuthorizedReveal(context)).rejects.toThrow(
      "Key reveal denied",
    );
    expect(provider.unwrapDataKey).not.toHaveBeenCalled();
    expect(audit.events.at(-1)?.eventType).toBe("KEY_ACCESS_DENIED");
  });

  it("supports metadata lookup and rewrap rotation", async () => {
    const repository = new InMemoryEncryptedKeyRepository();
    const audit = new CapturingAuditPort();
    const provider = new MemoryWrappingProvider("mk-v1");
    const newProvider = new MemoryWrappingProvider("mk-v2");
    const context = accessContext();
    const vault = new ProductKeyVaultService(
      repository,
      provider,
      authorization(true),
      audit,
      "CI",
    );
    const id = await vault.storeReceivedKey({
      correlationId: context.correlationId,
      orderLineId: context.orderLineId,
      receivedSecretMaterial: generatedSecret(),
    });
    const before = await repository.findById(id);

    await expect(vault.getKeyVersionMetadata(id)).resolves.toEqual({
      provider: "memory",
      version: "mk-v1",
    });
    await vault.rotateKeyEncryptionMetadata(
      id,
      newProvider,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    const after = await repository.findById(id);

    expect(after?.keyVersion).toBe("mk-v2");
    expect(after?.ciphertext).toEqual(before?.ciphertext);
    expect(after?.rotatedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("canary plaintext does not leak to logs, exceptions, audit, queue payload, or serialized encrypted metadata", async () => {
    const repository = new InMemoryEncryptedKeyRepository();
    const audit = new CapturingAuditPort();
    const provider = new MemoryWrappingProvider("mk-v1");
    const context = accessContext();
    const vault = new ProductKeyVaultService(
      repository,
      provider,
      authorization(false),
      audit,
      "CI",
    );
    const canary = generatedSecret();
    const canaryText = asText(canary);
    const capturedLog: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      capturedLog.push(String(message));
    });

    try {
      const recordId = await vault.storeReceivedKey({
        correlationId: context.correlationId,
        orderLineId: context.orderLineId,
        receivedSecretMaterial: canary,
      });
      const record = await repository.findById(recordId);
      const queuePayload = validateSafePayload({
        encryptedRecordId: recordId,
        orderLineId: context.orderLineId,
      });
      const exceptionMessages: string[] = [];

      await vault
        .retrieveForAuthorizedReveal(context)
        .catch((error: unknown) => {
          exceptionMessages.push(
            error instanceof Error ? error.message : String(error),
          );
        });

      expect(JSON.stringify(record)).not.toContain(canaryText);
      expect(JSON.stringify(audit.events)).not.toContain(canaryText);
      expect(JSON.stringify(queuePayload)).not.toContain(canaryText);
      expect(JSON.stringify(capturedLog)).not.toContain(canaryText);
      expect(JSON.stringify(exceptionMessages)).not.toContain(canaryText);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("retires key metadata without revealing product-key material", async () => {
    const repository = new InMemoryEncryptedKeyRepository();
    const vault = new ProductKeyVaultService(
      repository,
      new MemoryWrappingProvider("mk-v1"),
      authorization(true),
      new CapturingAuditPort(),
      "CI",
    );
    const context = accessContext();
    const id = await vault.storeReceivedKey({
      correlationId: context.correlationId,
      orderLineId: context.orderLineId,
      receivedSecretMaterial: randomBytes(16),
    });

    await vault.retireKey(keyRecordId(id), context.correlationId);

    await expect(vault.hasActiveKey(context.orderLineId)).resolves.toBe(false);
  });
});

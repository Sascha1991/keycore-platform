import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { OrderLineId } from "../domain/identifiers.js";

export const keyVaultAlgorithm = "AES-256-GCM-v1";

export interface EncryptedKeyMaterial {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly wrappedDataEncryptionKey: Uint8Array;
  readonly algorithm: typeof keyVaultAlgorithm;
  readonly keyVersion: string;
}

export interface StoredEncryptedKeyRecord extends EncryptedKeyMaterial {
  readonly id: string;
  readonly orderLineId: OrderLineId;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly retiredAt: Date | null;
}

export interface KeyManagementProvider {
  activeMasterKeyVersion(): Promise<string>;
  wrapDataKey(request: { readonly dataKey: Uint8Array }): Promise<{
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }>;
  unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }): Promise<Uint8Array>;
  getKeyVersionMetadata(
    keyVersion: string,
  ): Promise<Readonly<Record<string, string>>>;
}

export interface EncryptedKeyRepository {
  store(request: {
    readonly orderLineId: OrderLineId;
    readonly material: EncryptedKeyMaterial;
  }): Promise<StoredEncryptedKeyRecord>;
  findById(id: string): Promise<StoredEncryptedKeyRecord | null>;
  findActiveByOrderLineId(
    orderLineId: OrderLineId,
  ): Promise<StoredEncryptedKeyRecord | null>;
  rewrap(
    id: string,
    request: {
      readonly wrappedDataEncryptionKey: Uint8Array;
      readonly keyVersion: string;
      readonly rotatedAt: Date;
    },
  ): Promise<StoredEncryptedKeyRecord>;
  retire(id: string, retiredAt: Date): Promise<void>;
}

const dataKeyBytes = 32;
const nonceBytes = 12;

const toBuffer = (value: Uint8Array): Buffer =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

export const encryptProductKeyMaterial = async (
  receivedSecretMaterial: Uint8Array,
  keyManagementProvider: KeyManagementProvider,
): Promise<EncryptedKeyMaterial> => {
  const dataKey = randomBytes(dataKeyBytes);
  const nonce = randomBytes(nonceBytes);

  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(toBuffer(receivedSecretMaterial)),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();
    const wrapped = await keyManagementProvider.wrapDataKey({ dataKey });

    return {
      algorithm: keyVaultAlgorithm,
      authenticationTag,
      ciphertext,
      keyVersion: wrapped.keyVersion,
      nonce,
      wrappedDataEncryptionKey: wrapped.wrappedDataKey,
    };
  } finally {
    dataKey.fill(0);
  }
};

export const decryptProductKeyMaterial = async (
  material: EncryptedKeyMaterial,
  keyManagementProvider: KeyManagementProvider,
): Promise<Uint8Array> => {
  if (material.algorithm !== keyVaultAlgorithm) {
    throw new Error("Unsupported encrypted key material");
  }

  const dataKey = await keyManagementProvider.unwrapDataKey({
    keyVersion: material.keyVersion,
    wrappedDataKey: material.wrappedDataEncryptionKey,
  });

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      toBuffer(dataKey),
      toBuffer(material.nonce),
    );
    decipher.setAuthTag(toBuffer(material.authenticationTag));
    return Buffer.concat([
      decipher.update(toBuffer(material.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Encrypted key material verification failed");
  } finally {
    toBuffer(dataKey).fill(0);
  }
};

export const rewrapDataEncryptionKey = async (
  material: EncryptedKeyMaterial,
  oldProvider: KeyManagementProvider,
  newProvider: KeyManagementProvider,
): Promise<
  Pick<EncryptedKeyMaterial, "keyVersion" | "wrappedDataEncryptionKey">
> => {
  const dataKey = await oldProvider.unwrapDataKey({
    keyVersion: material.keyVersion,
    wrappedDataKey: material.wrappedDataEncryptionKey,
  });

  try {
    const wrapped = await newProvider.wrapDataKey({ dataKey });
    return {
      keyVersion: wrapped.keyVersion,
      wrappedDataEncryptionKey: wrapped.wrappedDataKey,
    };
  } finally {
    toBuffer(dataKey).fill(0);
  }
};

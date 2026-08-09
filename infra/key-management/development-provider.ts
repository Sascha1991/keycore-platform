import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { KeyManagementProvider } from "../../packages/platform/src/contracts.js";

const wrappingAlgorithm = "AES-256-GCM-WRAP-v1";
const nonceBytes = 12;

export interface DevelopmentKeyManagementProviderConfig {
  readonly environmentName: string;
  readonly masterKeyVersion: string;
  readonly masterKeyMaterialBase64: string | undefined;
}

interface WrappedDataKeyEnvelope {
  readonly algorithm: typeof wrappingAlgorithm;
  readonly ciphertext: string;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly tag: string;
}

const decodeMasterKey = (encoded: string | undefined): Buffer => {
  if (!encoded) {
    throw new Error("Development key-management material is not configured");
  }

  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error("Development key-management material is invalid");
  }

  return decoded;
};

export class DevelopmentKeyManagementProvider implements KeyManagementProvider {
  private readonly masterKey: Buffer;
  private readonly masterKeyVersion: string;

  public constructor(config: DevelopmentKeyManagementProviderConfig) {
    if (config.environmentName === "production") {
      throw new Error(
        "Development key-management provider is forbidden in production",
      );
    }

    this.masterKey = decodeMasterKey(config.masterKeyMaterialBase64);
    this.masterKeyVersion = config.masterKeyVersion;
  }

  public async activeMasterKeyVersion(): Promise<string> {
    return this.masterKeyVersion;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }): Promise<{
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }> {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(request.dataKey),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const envelope: WrappedDataKeyEnvelope = {
      algorithm: wrappingAlgorithm,
      ciphertext: ciphertext.toString("base64"),
      keyVersion: this.masterKeyVersion,
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
    };

    return {
      keyVersion: this.masterKeyVersion,
      wrappedDataKey: Buffer.from(JSON.stringify(envelope), "utf8"),
    };
  }

  public async unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }): Promise<Uint8Array> {
    if (request.keyVersion !== this.masterKeyVersion) {
      throw new Error("Wrapped data key version is unavailable");
    }

    try {
      const envelope = JSON.parse(
        Buffer.from(request.wrappedDataKey).toString("utf8"),
      ) as WrappedDataKeyEnvelope;
      if (
        envelope.algorithm !== wrappingAlgorithm ||
        envelope.keyVersion !== request.keyVersion
      ) {
        throw new Error("Invalid wrapped data key");
      }

      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.masterKey,
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      throw new Error("Wrapped data key verification failed");
    }
  }

  public async getKeyVersionMetadata(
    keyVersion: string,
  ): Promise<Readonly<Record<string, string>>> {
    if (keyVersion !== this.masterKeyVersion) {
      throw new Error("Key version metadata unavailable");
    }

    return {
      provider: "development",
      version: keyVersion,
    };
  }
}

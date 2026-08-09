import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DevelopmentKeyManagementProvider } from "./development-provider.js";

const generatedMasterMaterial = (): string =>
  randomBytes(32).toString("base64");

describe("development key-management provider", () => {
  it("wraps and unwraps data keys with configured local material", async () => {
    const provider = new DevelopmentKeyManagementProvider({
      environmentName: "test",
      masterKeyMaterialBase64: generatedMasterMaterial(),
      masterKeyVersion: "local-v1",
    });
    const dataKey = randomBytes(32);

    const wrapped = await provider.wrapDataKey({ dataKey });
    const unwrapped = await provider.unwrapDataKey({
      keyVersion: wrapped.keyVersion,
      wrappedDataKey: wrapped.wrappedDataKey,
    });

    expect(wrapped.keyVersion).toBe("local-v1");
    expect(Buffer.from(wrapped.wrappedDataKey).equals(dataKey)).toBe(false);
    expect(Buffer.from(unwrapped).equals(dataKey)).toBe(true);
  });

  it("fails closed when local master-key material is missing", () => {
    expect(
      () =>
        new DevelopmentKeyManagementProvider({
          environmentName: "test",
          masterKeyMaterialBase64: undefined,
          masterKeyVersion: "local-v1",
        }),
    ).toThrow("not configured");
  });

  it("refuses production environment use", () => {
    expect(
      () =>
        new DevelopmentKeyManagementProvider({
          environmentName: "production",
          masterKeyMaterialBase64: generatedMasterMaterial(),
          masterKeyVersion: "local-v1",
        }),
    ).toThrow("forbidden in production");
  });

  it("fails closed on tampered wrapped data keys", async () => {
    const provider = new DevelopmentKeyManagementProvider({
      environmentName: "test",
      masterKeyMaterialBase64: generatedMasterMaterial(),
      masterKeyVersion: "local-v1",
    });
    const wrapped = await provider.wrapDataKey({ dataKey: randomBytes(32) });
    const tampered = Buffer.from(wrapped.wrappedDataKey);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

    await expect(
      provider.unwrapDataKey({
        keyVersion: wrapped.keyVersion,
        wrappedDataKey: tampered,
      }),
    ).rejects.toThrow("verification failed");
  });
});

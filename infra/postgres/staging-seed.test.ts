import { describe, expect, it, vi } from "vitest";

import type { TransactionalQueryable } from "./client.js";
import { seedSyntheticStagingData } from "./staging-seed.js";

describe("synthetic staging seed safety", () => {
  it.each([undefined, "LOCAL", "TEST", "PRODUCTION"])(
    "refuses environment %s before opening a transaction",
    async (environment) => {
      const database = rejectingBoundary();

      await expect(
        seedSyntheticStagingData(database.boundary, {
          deploymentId: "staging-ci-001",
          environment,
        }),
      ).rejects.toThrow("STAGING_SEED_ENVIRONMENT_REQUIRED");
      expect(database.transaction).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    },
  );

  it("refuses malformed staging deployment identity", async () => {
    const database = rejectingBoundary();

    await expect(
      seedSyntheticStagingData(database.boundary, {
        deploymentId: "production",
        environment: "STAGING",
      }),
    ).rejects.toThrow("STAGING_SEED_ENVIRONMENT_REQUIRED");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

const rejectingBoundary = () => {
  const query = vi.fn();
  const transaction = vi.fn();
  const boundary: TransactionalQueryable = {
    query: async () => {
      query();
      throw new Error("unexpected query");
    },
    transaction: async () => {
      transaction();
      throw new Error("unexpected transaction");
    },
  };
  return {
    boundary,
    query,
    transaction,
  };
};

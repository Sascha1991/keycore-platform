import { describe, expect, it, type TestContext } from "vitest";

import {
  runRecoveryExercise,
  validateRecoveryEnvironment,
} from "./recovery-exercise.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const redisUrl = process.env.KEYCORE_TEST_REDIS_URL;

describe("KS-11-06 recovery exercise", () => {
  it("rejects production, ambiguous, same-database and non-isolated recovery identities", () => {
    const safe = {
      connectionString:
        "postgres://synthetic:synthetic@localhost:5432/keycore_test",
      sourceClassification: "CI_TEST",
      sourceDatabase: "keycore_recovery_source_abcdef123456",
      targetClassification: "ISOLATED_RECOVERY",
      targetDatabase: "keycore_recovery_restore_abcdef123456",
    } as const;
    expect(validateRecoveryEnvironment(safe)).toEqual({ status: "ACCEPTED" });
    for (const unsafe of [
      { ...safe, sourceClassification: "PRODUCTION" },
      { ...safe, sourceClassification: undefined },
      { ...safe, targetClassification: "PRODUCTION" },
      { ...safe, targetClassification: undefined },
      { ...safe, connectionString: "postgres://example.invalid/keycore_test" },
      { ...safe, connectionString: "postgres://localhost/keycore" },
      { ...safe, targetDatabase: safe.sourceDatabase },
      { ...safe, targetDatabase: "arbitrary_restore" },
    ]) {
      expect(validateRecoveryEnvironment(unsafe)).toEqual({
        status: "REJECTED",
      });
    }
  });

  it("executes REC-001 through REC-018 with a native isolated PostgreSQL restore", async (context: TestContext) => {
    if (!connectionString || !redisUrl) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error("RECOVERY_REQUIRED_CI_SERVICE_MISSING");
      }
      context.skip();
      return;
    }
    const result = await runRecoveryExercise({
      connectionString,
      redisUrl,
      sourceClassification:
        process.env.GITHUB_ACTIONS === "true" ? "CI_TEST" : "LOCAL_TEST",
    });
    expect(result.scenarios).toHaveLength(18);
    expect(
      result.scenarios.every((scenario) => scenario.status === "PASS"),
    ).toBe(true);
    expect(result.databaseRecovery).toBe("VALIDATED");
    expect(result.sourceTargetDistinct).toBe(true);
    expect(result.sourceDatabaseFingerprint).not.toBe(
      result.targetDatabaseFingerprint,
    );
    expect(result.backup.sizeBytes).toBeGreaterThan(0);
    expect(result.migrationBaseline).toBe("027");
    expect(Object.values(result.invariantCounts)).toEqual(
      expect.arrayContaining([0]),
    );
    expect(
      Object.values(result.invariantCounts).every((count) => count === 0),
    ).toBe(true);
    expect(result.redis).toEqual({
      correctnessAuthority: false,
      emptyAfterLoss: true,
      rebuildSafe: true,
    });
    expect(result.externalNetwork).toBe(false);
    expect(result.productionRpoTarget).toBe("NOT_YET_APPROVED");
    expect(result.productionRtoTarget).toBe("NOT_YET_APPROVED");
  }, 120_000);
});

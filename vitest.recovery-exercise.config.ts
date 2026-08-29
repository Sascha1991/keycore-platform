import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["infra/recovery/recovery-exercise.test.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
});

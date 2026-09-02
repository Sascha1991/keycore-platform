import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "infra/postgres/catalog-scale.test.ts",
      "infra/recovery/recovery-exercise.test.ts",
    ],
    include: ["infra/**/*.test.ts", "packages/**/*.test.ts"],
    ...(process.env.KEYCORE_TEST_DATABASE_URL ? { maxWorkers: 1 } : {}),
    passWithNoTests: false,
  },
});

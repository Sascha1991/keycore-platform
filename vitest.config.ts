import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "infra/postgres/catalog-scale.test.ts",
      "infra/recovery/recovery-exercise.test.ts",
    ],
    include: ["infra/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false,
  },
});

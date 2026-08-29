import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    include: ["infra/postgres/catalog-scale.test.ts"],
    passWithNoTests: false,
    testTimeout: 360_000,
  },
});

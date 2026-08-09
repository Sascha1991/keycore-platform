import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["infra/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false
  }
});

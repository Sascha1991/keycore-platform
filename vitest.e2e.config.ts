import { defineConfig } from "vitest/config";

import { SafeAcceptanceEvidenceReporter } from "./infra/e2e/safe-acceptance-evidence-reporter.js";

export default defineConfig({
  test: {
    include: [
      "infra/e2e/keycore-acceptance.test.ts",
      "infra/postgres/e2e-acceptance-persistence.test.ts",
    ],
    passWithNoTests: false,
    reporters: ["default", new SafeAcceptanceEvidenceReporter()],
  },
});

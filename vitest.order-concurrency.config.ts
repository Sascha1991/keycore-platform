import { defineConfig } from "vitest/config";

import { OrderConcurrencyEvidenceReporter } from "./infra/postgres/order-concurrency-evidence-reporter.js";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    include: [
      "infra/postgres/order-persistence.test.ts",
      "infra/postgres/price-lock-persistence.test.ts",
      "infra/postgres/payment-persistence.test.ts",
      "infra/postgres/procurement-persistence.test.ts",
      "infra/postgres/fulfillment-persistence.test.ts",
      "infra/postgres/customer-key-delivery-persistence.test.ts",
      "infra/postgres/guest-order-claim-persistence.test.ts",
    ],
    passWithNoTests: false,
    reporters: ["default", new OrderConcurrencyEvidenceReporter()],
    testTimeout: 60_000,
  },
});

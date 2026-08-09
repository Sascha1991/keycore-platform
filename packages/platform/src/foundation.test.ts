import { describe, expect, it } from "vitest";

import { foundationStatus } from "./foundation.js";

describe("KS-01-01 foundation guardrails", () => {
  it("keeps production integrations disabled in the foundation task", () => {
    expect(foundationStatus).toEqual({
      taskId: "KS-01-01",
      productionBusinessLogicImplemented: false,
      realSupplierIntegrationEnabled: false,
      livePaymentCredentialsAllowed: false,
    });
  });
});

export const foundationStatus = {
  taskId: "KS-01-01",
  productionBusinessLogicImplemented: false,
  realSupplierIntegrationEnabled: false,
  livePaymentCredentialsAllowed: false,
} as const;

export type FoundationStatus = typeof foundationStatus;

import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../customers/in-memory-customer-account-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerRegistrationChallengeRepository } from "../customers/in-memory-customer-registration-repository.js";
import { InMemoryGuestOrderClaimRepository } from "../customers/in-memory-guest-order-claim-repository.js";
import { InMemorySupplierClaimRepository } from "../claims/in-memory-supplier-claim-repository.js";
import { InMemoryFraudRiskRepository } from "../fraud/in-memory-fraud-risk-repository.js";
import { InMemoryCustomerKeyDeliveryRepository } from "../fulfillment/in-memory-customer-key-delivery-repository.js";
import { InMemoryFulfillmentRepository } from "../fulfillment/in-memory-fulfillment-repository.js";
import { DevelopmentKeyManagementProvider } from "../key-management/development-provider.js";
import { InMemoryOrderRepository } from "../orders/in-memory-order-repository.js";
import { InMemoryPaymentRepository } from "../payments/in-memory-payment-repository.js";
import { InMemoryProcurementOperationRepository } from "../procurement/in-memory-procurement-repository.js";
import { InMemoryPriceLockRepository } from "../pricing/in-memory-pricing-repository.js";
import { InMemorySupportCaseRepository } from "../support/in-memory-support-case-repository.js";
import {
  CustomerInvoiceAccessService,
  CustomerKeyAccessService,
  CustomerKeyDeliveryService,
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  FakeGuestOrderClaimDeliveryPort,
  FraudRiskService,
  GuestOrderClaimService,
  OperationsControlService,
  OrderOrchestrationService,
  PersistedGuestOrderClaimAuthority,
  PersistedGuestOrderClaimIssuanceAuthority,
  PersistedCustomerOrderAuthorizationPort,
  PriceLockService,
  SecureKeyFulfillmentService,
  SupplierClaimService,
  SupplierProcurementService,
  SupplierRegistry,
  SupportCaseService,
  correlationId,
  currency,
  customerId,
  encryptFulfillmentSecret,
  encryptProductKeyMaterial,
  fulfillmentEncryptionContext,
  money,
  offerId,
  orderId,
  orderLineId,
  productId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerPrincipal,
  type AuthenticatedCustomerPrincipalProvider,
  type CorrelationId,
  type CustomerAccountOrderProjection,
  type CustomerDeliveryAuthorization,
  type CustomerId,
  type CustomerKeyDeliveryPort,
  type CustomerKeyDeliveryPortResult,
  type EmailVerificationAuthorityPort,
  type FraudManualReviewAuthorityPort,
  type FulfillmentOperation,
  type FulfillmentProcurementEvidencePort,
  type KeyCoreOrder,
  type KeyManagementProvider,
  type OperationsCapability,
  type OperationsControl,
  type OperationsControlGate,
  type OperationsControlRepository,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
  type PricingService,
  type ProductId,
  type ProductPriceSelection,
  type SellPriceQuote,
  type SupplierClaimAuthorityPort,
  type SupplierClaimSubmissionPort,
  type SupplierPort,
  type SupplierRoutingCandidate,
  type SupplierRoutingPolicy,
  type SupplierRoutingService,
  type SupplierKeyRetrievalPort,
  type SupportOperatorAuthorityPort,
} from "../../packages/platform/src/contracts.js";
import {
  StripePaymentService,
  stripePaymentMetadata,
  type NormalizedStripePaymentIntent,
  type PaymentProviderCreateResult,
  type PaymentProviderRetrieveResult,
  type StripePaymentIntentCreateInput,
  type StripePaymentProviderPort,
  type StripeWebhookVerifier,
  type VerifiedStripeEvent,
} from "../../packages/platform/src/payments/stripe-payments.js";

const now = new Date("2026-08-28T12:00:00.000Z");
const eur = currency("EUR");
const sensitiveCanary = "KEYRANO_E2E_SYNTHETIC_SECRET_CANARY_15001";
const syntheticClaimCode = "KEYRANO_E2E_SYNTHETIC_CLAIM_15002_LONG_ENOUGH";

describe("KS-11-02 end-to-end acceptance", () => {
  it("E2E-001 ACCOUNT_PURCHASE_SUCCESS", async () => {
    const journey = await createOrderJourney("account-success");
    const replay = await journey.orders.createOrder(journey.createInput);
    expect(replay.status).toBe("IDEMPOTENT");

    const payment = paymentHarness(journey);
    await expect(
      payment.service.initializePayment({
        correlationId: correlationId("e2e-001-payment-init"),
        orderId: journey.order.id,
      }),
    ).resolves.toMatchObject({ status: "INITIALIZED" });
    payment.verifier.event = paymentEvent(journey.order, "succeeded");
    await expect(
      payment.service.processWebhook({
        correlationId: correlationId("e2e-001-payment-webhook"),
        rawBody: "synthetic-e2e-event",
        signatureHeader: "valid-synthetic-signature",
      }),
    ).resolves.toMatchObject({ status: "INITIALIZED" });

    const captured = await journey.orders.getOrder(journey.order.id);
    if (!captured) throw new Error("Captured E2E order missing");
    const completed = await completeApprovedOrder(journey, captured);
    expect(completed).toMatchObject({
      fulfillmentStatus: "SUCCEEDED",
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      riskStatus: "APPROVED",
      status: "COMPLETED",
    });
    expect(await journey.repository.listHistory(completed.id)).toHaveLength(9);

    const identity = await createVerifiedOwnedIdentity(completed);
    expect(identity.ownership.status).toBe("BOUND");

    const delivery = await exerciseSecureCustomerDelivery(completed, identity);
    expect(delivery.encryptedSecretCount).toBe(1);
    expect(delivery.deliveryCount).toBe(1);
    expect(delivery.replayStatus).toBe("ALREADY_DELIVERED");
    assertSensitiveAbsent(
      {
        audit: journey.audit.events,
        delivery: delivery.safeSurface,
        order: completed,
      },
      sensitiveCanary,
      "successful journey safe surfaces",
    );
  });

  it("E2E-002 GUEST_PURCHASE_ACCOUNT_CLAIM", async () => {
    const harness = guestClaimHarness();
    const guestOrder = orderId("20000000-0000-4000-8000-000000000002");
    harness.identityRepository.addOrder({
      checkoutEmailNormalized: "guest@example.test",
      customerId: null,
      fulfillmentStatus: "PENDING",
      orderId: guestOrder,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 1,
      status: "FULFILLMENT_PENDING",
      updatedAt: now,
    });

    await expect(
      harness.claims.issueGuestOrderClaim({
        checkoutEmail: "guest@example.test",
        correlationId: correlationId("e2e-002-issue"),
        orderId: guestOrder,
      }),
    ).resolves.toEqual({ status: "ISSUED" });
    const challenge = [...harness.claimRepository.challenges.values()][0];
    expect(challenge).toBeDefined();
    assertSensitiveAbsent(challenge, syntheticClaimCode, "claim persistence");

    const wrongCustomer = await registerVerifiedCustomer(
      harness,
      "wrong@example.test",
    );
    await expect(
      harness.registration.claimGuestOrder({
        claimCode: syntheticClaimCode,
        correlationId: correlationId("e2e-002-wrong"),
        principal: principal(wrongCustomer),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });

    const owner = await registerVerifiedCustomer(harness, "guest@example.test");
    await expect(
      harness.registration.claimGuestOrder({
        claimCode: "incorrect-but-long-enough-claim-code-15002",
        correlationId: correlationId("e2e-002-no-token"),
        orderId: guestOrder,
        principal: principal(owner),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
    await expect(
      harness.registration.claimGuestOrder({
        claimCode: syntheticClaimCode,
        correlationId: correlationId("e2e-002-claim"),
        principal: principal(owner),
      }),
    ).resolves.toEqual({ orderId: guestOrder, status: "CLAIMED" });
    await expect(
      harness.registration.claimGuestOrder({
        claimCode: syntheticClaimCode,
        correlationId: correlationId("e2e-002-replay"),
        principal: principal(owner),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
    expect(
      await harness.identityRepository.inspectOrderOwnership(guestOrder),
    ).toMatchObject({ ownerCustomerId: owner, ownershipBound: true });
    assertSensitiveAbsent(
      { audit: harness.audit.events, persisted: challenge },
      syntheticClaimCode,
      "guest claim safe surfaces",
    );
  });

  it("E2E-003 DELAYED_FULFILLMENT", async () => {
    const journey = await createOrderJourney("delayed");
    let order = await captureAndApprove(journey);
    order = await mustUpdate(
      journey.orders.markProcurementPending(command(order)),
    );
    expect(order).toMatchObject({
      fulfillmentStatus: "NOT_STARTED",
      procurementStatus: "PENDING",
      status: "PROCUREMENT_PENDING",
    });

    order = await mustUpdate(journey.orders.beginProcurement(command(order)));
    order = await mustUpdate(
      journey.orders.recordProcurementResult({
        ...command(order),
        procurementStatus: "SUCCEEDED",
      }),
    );
    order = await mustUpdate(
      journey.orders.markFulfillmentPending(command(order)),
    );
    order = await mustUpdate(
      journey.orders.recordFulfillmentResult({
        ...command(order),
        fulfillmentStatus: "SUCCEEDED",
      }),
    );
    expect(order.status).toBe("COMPLETED");
    expect(await journey.repository.listHistory(order.id)).toHaveLength(10);
  });

  it("E2E-004 SUPPLIER_FAILURE", async () => {
    const journey = await createOrderJourney("supplier-failure");
    let order = await captureAndApprove(journey);
    order = await mustUpdate(
      journey.orders.markProcurementPending(command(order)),
    );
    order = await mustUpdate(journey.orders.beginProcurement(command(order)));
    order = await mustUpdate(
      journey.orders.recordProcurementResult({
        ...command(order),
        procurementStatus: "FAILED_TERMINAL",
      }),
    );
    expect(order).toMatchObject({
      fulfillmentStatus: "NOT_STARTED",
      paymentStatus: "CAPTURED",
      procurementStatus: "FAILED_TERMINAL",
      status: "FAILED",
    });
    expect(await journey.repository.listHistory(order.id)).toHaveLength(8);
  });

  it("E2E-005 SUPPLIER_AMBIGUOUS", async () => {
    const journey = await createOrderJourney("supplier-ambiguous");
    await captureAndApprove(journey);
    const procurement = procurementHarness(journey, {
      reconciliationOutcomes: ["STILL_AMBIGUOUS", "RESOLVED"],
    });

    const first = await procurement.service.startProcurement({
      correlationId: correlationId("e2e-005-dispatch"),
      orderId: journey.order.id,
    });
    expect(first).toMatchObject({
      reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
      status: "AMBIGUOUS",
    });
    expect(procurement.original.purchaseDispatchCount).toBe(1);
    expect(procurement.fallback.purchaseDispatchCount).toBe(0);

    await expect(
      procurement.service.startProcurement({
        correlationId: correlationId("e2e-005-replay"),
        orderId: journey.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PROCUREMENT_AMBIGUOUS",
      status: "AMBIGUOUS",
    });
    expect(procurement.original.purchaseDispatchCount).toBe(1);
    expect(procurement.fallback.purchaseDispatchCount).toBe(0);

    const operationId = requiredOperation(first.operation?.id);
    await expect(
      procurement.service.reconcileOperation({
        correlationId: correlationId("e2e-005-reconcile-unresolved"),
        operationId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PROCUREMENT_AMBIGUOUS",
      status: "AMBIGUOUS",
    });
    expect(procurement.original.reconciliationLookupCount).toBe(1);
    expect(procurement.original.purchaseDispatchCount).toBe(1);
    expect(procurement.fallback.purchaseDispatchCount).toBe(0);

    await expect(
      procurement.service.reconcileOperation({
        correlationId: correlationId("e2e-005-reconcile-resolved"),
        operationId,
      }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(procurement.original.reconciliationLookupCount).toBe(2);
    expect(procurement.original.purchaseDispatchCount).toBe(1);
    expect(procurement.fallback.purchaseDispatchCount).toBe(0);
    await expect(
      procurement.service.startProcurement({
        correlationId: correlationId("e2e-005-after-resolution"),
        orderId: journey.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PROCUREMENT_ALREADY_SUCCEEDED",
      status: "BLOCKED",
    });

    const operations = await procurement.repository.listByOrder(
      journey.order.id,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(procurement.fulfillments.operations.size).toBe(0);
    expect(procurement.fulfillments.secrets.size).toBe(0);
    await expect(
      journey.orders.getOrder(journey.order.id),
    ).resolves.toMatchObject({
      fulfillmentStatus: "NOT_STARTED",
      procurementStatus: "AMBIGUOUS",
      status: "MANUAL_REVIEW",
    });
    assertSensitiveAbsent(
      {
        audit: journey.audit.events,
        history: await journey.repository.listHistory(journey.order.id),
        operationCount: operations.length,
      },
      sensitiveCanary,
      "ambiguous procurement safe metadata",
    );
  });

  it("E2E-006 PAYMENT_FAILURE", async () => {
    const journey = await createOrderJourney("payment-failure");
    const payment = paymentHarness(journey);
    await payment.service.initializePayment({
      correlationId: correlationId("e2e-006-payment-init"),
      orderId: journey.order.id,
    });
    payment.verifier.event = paymentEvent(journey.order, "payment_failed");
    await expect(
      payment.service.processWebhook({
        correlationId: correlationId("e2e-006-payment-webhook"),
        rawBody: "synthetic-e2e-event",
        signatureHeader: "valid-synthetic-signature",
      }),
    ).resolves.toMatchObject({ reasonCode: "PAYMENT_FAILED" });
    const order = await journey.orders.getOrder(journey.order.id);
    if (!order) throw new Error("Failed E2E payment order missing");
    expect(order).toMatchObject({
      fulfillmentStatus: "NOT_STARTED",
      paymentStatus: "FAILED",
      procurementStatus: "NOT_STARTED",
      status: "FAILED",
    });
    await expect(
      journey.orders.markProcurementPending(command(order)),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT",
      status: "BLOCKED",
    });
  });

  it("E2E-007 FRAUD_REVIEW", async () => {
    const repository = new InMemoryFraudRiskRepository();
    const order = riskOrder("70000000-0000-4000-8000-000000000007", {
      paymentStatus: "PENDING",
      status: "AWAITING_PAYMENT",
    });
    repository.addOrder(order);
    const service = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudReviewAuthority(),
      now: () => now,
      repository,
    });
    const evaluated = await service.evaluateOrder({
      correlationId: correlationId("e2e-007-review"),
      orderId: order.id,
    });
    expect(evaluated).toMatchObject({
      evaluation: { decision: "REVIEW" },
      reviewCase: { status: "OPEN" },
      status: "EVALUATED",
    });
    await expect(service.isFraudCleared(order.id)).resolves.toMatchObject({
      status: "BLOCKED",
    });
    if (evaluated.status !== "EVALUATED" || !evaluated.reviewCase) {
      throw new Error("Expected current fraud review case");
    }
    await expect(
      service.resolveManualReview({
        caseId: evaluated.reviewCase.caseId,
        correlationId: correlationId("e2e-007-stale"),
        expectedFactFingerprint: "stale-fingerprint",
        resolution: "APPROVE",
      }),
    ).resolves.toMatchObject({ status: "DENIED" });
    await expect(
      service.resolveManualReview({
        caseId: evaluated.reviewCase.caseId,
        correlationId: correlationId("e2e-007-approve"),
        expectedFactFingerprint: evaluated.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
    ).resolves.toMatchObject({ status: "RESOLVED" });
    await expect(service.isFraudCleared(order.id)).resolves.toMatchObject({
      status: "CLEARED",
    });
  });

  it("E2E-008 FRAUD_DENY", async () => {
    const repository = new InMemoryFraudRiskRepository();
    const order = riskOrder("80000000-0000-4000-8000-000000000008", {
      paymentStatus: "PENDING",
      status: "FAILED",
    });
    repository.addOrder(order);
    const service = new FraudRiskService({ now: () => now, repository });
    await expect(
      service.evaluateOrder({
        correlationId: correlationId("e2e-008-deny"),
        orderId: order.id,
      }),
    ).resolves.toMatchObject({ evaluation: { decision: "DENY" } });
    await expect(service.isFraudCleared(order.id)).resolves.toEqual({
      reasonCode: "FRAUD_DENIED",
      status: "BLOCKED",
    });
  });

  it("E2E-009 REFUND", async () => {
    const journey = await createOrderJourney("refund");
    let order = await completePaidOrder(journey);
    order = await mustUpdate(journey.orders.requestRefund(command(order)));
    const staleReplay = await journey.orders.requestRefund({
      ...command(order),
      expectedVersion: order.recordVersion - 1,
    });
    expect(staleReplay.status).toBe("CONFLICT");
    order = await mustUpdate(
      journey.orders.recordRefundResult({
        ...command(order),
        refundStatus: "SUCCEEDED",
      }),
    );
    expect(order).toMatchObject({
      paymentStatus: "REFUNDED",
      refundStatus: "SUCCEEDED",
      status: "REFUNDED",
    });
  });

  it("E2E-010 SUPPORT", async () => {
    const owner = customerId("10000000-0000-4000-8000-000000000010");
    const other = customerId("10000000-0000-4000-8000-000000000011");
    const ownedOrder = orderId("10000000-0000-4000-8000-000000000012");
    const repository = new InMemorySupportCaseRepository();
    repository.addCustomer(owner);
    repository.addCustomer(other);
    repository.addOrder({ customerId: owner, orderId: ownedOrder });
    const audit = new AuditSink();
    const service = new SupportCaseService({
      audit,
      now: () => now,
      operatorAuthority: new TrustedSupportAuthority(),
      repository,
    });
    const created = await service.createCustomerCase({
      category: "ORDER_STATUS",
      correlationId: correlationId("e2e-010-create"),
      message: "Synthetic customer assertion about delayed delivery",
      orderId: ownedOrder,
      principal: principal(owner),
    });
    expect(created.status).toBe("CREATED");
    await expect(
      service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("e2e-010-denied"),
        message: "Unauthorized synthetic assertion",
        orderId: ownedOrder,
        principal: principal(other),
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
    if (created.status !== "CREATED") throw new Error("Support case missing");
    const persisted = repository.snapshot(created.detail.case.id);
    if (!persisted) throw new Error("Support persistence missing");
    await expect(
      service.transitionCase({
        caseId: persisted.case.id,
        correlationId: correlationId("e2e-010-resolve"),
        expectedVersion: persisted.case.recordVersion,
        nextStatus: "RESOLVED",
        resolutionCode: "INFORMATION_PROVIDED",
      }),
    ).resolves.toMatchObject({ detail: { case: { status: "RESOLVED" } } });
    assertSensitiveAbsent(
      { audit: audit.events, customer: created },
      sensitiveCanary,
      "support surfaces",
    );
  });

  it("E2E-011 REPLAY_IDEMPOTENCY", async () => {
    const journey = await createOrderJourney("replay");
    const sameOrder = await journey.orders.createOrder(journey.createInput);
    expect(sameOrder).toMatchObject({
      order: { id: journey.order.id },
      status: "IDEMPOTENT",
    });
    const payment = paymentHarness(journey);
    await payment.service.initializePayment({
      correlationId: correlationId("e2e-011-payment-init"),
      orderId: journey.order.id,
    });
    payment.verifier.event = paymentEvent(journey.order, "succeeded");
    const webhook = {
      correlationId: correlationId("e2e-011-event"),
      rawBody: "synthetic-e2e-event",
      signatureHeader: "valid-synthetic-signature",
    } as const;
    await expect(
      payment.service.processWebhook(webhook),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_CAPTURE_CONFIRMED",
      status: "INITIALIZED",
    });
    await expect(
      payment.service.processWebhook(webhook),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_WEBHOOK_VERIFIED",
      status: "IDEMPOTENT",
    });
    await expect(
      journey.orders.getOrder(journey.order.id),
    ).resolves.toMatchObject({
      paymentStatus: "CAPTURED",
      status: "PAYMENT_CAPTURED",
    });
  });

  it("E2E-012 EMERGENCY_CONTROLS", async () => {
    const checkoutControls = operationsGate({ paused: "CHECKOUT_CREATE" });
    const checkout = await createOrderJourney("paused-checkout", {
      operationsControlGate: checkoutControls.gate,
    });
    expect(checkout.createResult).toMatchObject({
      reasonCode: "OPERATIONS_CONTROL_BLOCKED",
      status: "BLOCKED",
    });
    expect(
      await checkout.repository.findByIdempotencyKey("order-paused-checkout"),
    ).toBeNull();

    const globalControls = operationsGate({
      paused: "GLOBAL_COMMERCE_MUTATIONS",
    });
    const globallyPaused = await createOrderJourney("paused-global", {
      operationsControlGate: globalControls.gate,
    });
    expect(globallyPaused.createResult).toMatchObject({
      reasonCode: "OPERATIONS_CONTROL_BLOCKED",
      status: "BLOCKED",
    });
    expect(
      await globallyPaused.repository.findByIdempotencyKey(
        "order-paused-global",
      ),
    ).toBeNull();

    const procurementJourney = await createOrderJourney("paused-procurement");
    await captureAndApprove(procurementJourney);
    const pausedProcurement = procurementHarness(procurementJourney, {
      operationsControlGate: operationsGate({ paused: "PROCUREMENT_CREATE" })
        .gate,
    });
    await expect(
      pausedProcurement.service.startProcurement({
        correlationId: correlationId("e2e-012-procurement"),
        orderId: procurementJourney.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      status: "BLOCKED",
    });
    expect(pausedProcurement.original.purchaseDispatchCount).toBe(0);
    expect(pausedProcurement.fallback.purchaseDispatchCount).toBe(0);
    await expect(
      pausedProcurement.repository.listByOrder(procurementJourney.order.id),
    ).resolves.toMatchObject([
      { dispatchState: "NOT_DISPATCHED", status: "READY" },
    ]);

    const retrieval = await exercisePausedSupplierKeyRetrieval(
      operationsGate({ paused: "SUPPLIER_KEY_RETRIEVAL" }).gate,
    );
    expect(retrieval).toMatchObject({
      encryptedSecretCount: 0,
      retrievalCallCount: 0,
      retrievalState: "NOT_STARTED",
      status: "BLOCKED",
    });

    const deliveryJourney = await createOrderJourney("paused-delivery");
    const completed = await completePaidOrder(deliveryJourney);
    const deliveryIdentity = await createVerifiedOwnedIdentity(completed);
    const pausedDelivery = await exerciseSecureCustomerDelivery(
      completed,
      deliveryIdentity,
      {
        operationsControlGate: operationsGate({
          paused: "CUSTOMER_KEY_DELIVERY",
        }).gate,
        paused: true,
      },
    );
    expect(pausedDelivery).toMatchObject({
      deliveryCount: 0,
      encryptedSecretCount: 1,
      executeStatus: "DENIED",
      unwrapCount: 0,
    });

    const supplierClaim = await exercisePausedSupplierClaim(
      operationsGate({ paused: "SUPPLIER_CLAIM_SUBMISSION" }).gate,
    );
    expect(supplierClaim).toMatchObject({
      dispatchCount: 0,
      status: "FAILED",
      submissionStatus: "PREPARED",
    });

    const enabledButUnpaid = await createOrderJourney("enabled-not-authority", {
      operationsControlGate: operationsGate().gate,
    });
    const unauthorizedProcurement = procurementHarness(enabledButUnpaid, {
      operationsControlGate: operationsGate().gate,
    });
    await expect(
      unauthorizedProcurement.service.startProcurement({
        correlationId: correlationId("e2e-012-enabled-not-authority"),
        orderId: enabledButUnpaid.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_NOT_CAPTURED",
      status: "BLOCKED",
    });
    expect(unauthorizedProcurement.original.purchaseDispatchCount).toBe(0);

    for (const unavailableMode of ["MISSING", "MALFORMED"] as const) {
      const unavailable = await createOrderJourney(
        `unavailable-${unavailableMode.toLowerCase()}`,
        {
          operationsControlGate: operationsGate({ unavailableMode }).gate,
        },
      );
      expect(unavailable.createResult).toMatchObject({
        reasonCode: "OPERATIONS_CONTROL_BLOCKED",
        status: "BLOCKED",
      });
    }

    const webhookControls = operationsGate();
    const webhookJourney = await createOrderJourney("global-webhook", {
      operationsControlGate: webhookControls.gate,
    });
    const payment = paymentHarness(webhookJourney);
    await payment.service.initializePayment({
      correlationId: correlationId("e2e-012-payment-init"),
      orderId: webhookJourney.order.id,
    });
    webhookControls.repository.pause("GLOBAL_COMMERCE_MUTATIONS");
    payment.verifier.event = paymentEvent(webhookJourney.order, "succeeded");
    await expect(
      payment.service.processWebhook({
        correlationId: correlationId("e2e-012-payment-webhook"),
        rawBody: "synthetic-e2e-event",
        signatureHeader: "valid-synthetic-signature",
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_CAPTURE_CONFIRMED",
      status: "INITIALIZED",
    });
    await expect(
      webhookJourney.orders.getOrder(webhookJourney.order.id),
    ).resolves.toMatchObject({ paymentStatus: "CAPTURED" });
  });

  it("E2E-013 EMAIL_SAFETY", async () => {
    const harness = guestClaimHarness();
    const guestOrder = orderId("13000000-0000-4000-8000-000000000013");
    harness.identityRepository.addOrder({
      checkoutEmailNormalized: "mail@example.test",
      customerId: null,
      fulfillmentStatus: "NOT_STARTED",
      orderId: guestOrder,
      paymentStatus: "CAPTURED",
      procurementStatus: "NOT_STARTED",
      recordVersion: 1,
      status: "PAYMENT_CAPTURED",
      updatedAt: now,
    });
    await harness.claims.issueGuestOrderClaim({
      checkoutEmail: "mail@example.test",
      correlationId: correlationId("e2e-013-mail"),
      orderId: guestOrder,
    });
    expect(harness.delivery.deliveries).toHaveLength(1);
    const safeMailContract = {
      challengeId: harness.delivery.deliveries[0]?.challengeId,
      emailNormalized: harness.delivery.deliveries[0]?.emailNormalized,
      expiresAt: harness.delivery.deliveries[0]?.expiresAt,
      orderId: harness.delivery.deliveries[0]?.orderId,
      purpose: "GUEST_ORDER_ACCOUNT_CLAIM",
    };
    assertSensitiveAbsent(safeMailContract, sensitiveCanary, "mail contract");
    expect(safeSerialize(safeMailContract)).not.toMatch(
      /password|session|stack|supplierPayload|productKey/iu,
    );
  });

  it("E2E-014 INVOICE_ACCESS", async () => {
    const owner = customerId("14000000-0000-4000-8000-000000000014");
    const other = customerId("14000000-0000-4000-8000-000000000015");
    const invoiceOrder = accountOrderProjection(owner);
    const repository = new InMemoryCustomerAccountReadRepository();
    repository.addOrder(invoiceOrder);
    const service = new CustomerInvoiceAccessService({
      now: () => now,
      repository,
    });
    const allowed = await service.getInvoiceMetadata({
      correlationId: correlationId("e2e-014-owner"),
      orderId: invoiceOrder.orderId,
      principal: principal(owner),
    });
    expect(allowed).toMatchObject({
      invoice: { downloadAvailable: true, status: "AVAILABLE" },
      status: "OK",
    });
    await expect(
      service.getInvoiceMetadata({
        correlationId: correlationId("e2e-014-denied"),
        orderId: invoiceOrder.orderId,
        principal: principal(other),
      }),
    ).resolves.toEqual({ code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" });
    expect(safeSerialize(allowed)).not.toMatch(
      /productKey|ciphertext|supplier/iu,
    );
  });

  it("E2E-015 LEAKAGE_CANARY", async () => {
    const journey = await createOrderJourney("leakage");
    const encrypted = await encryptSyntheticCanary(journey.order.id);
    const safeSurfaces = {
      audit: journey.audit.events,
      evidence: {
        environment: "CI",
        finalState: journey.order.status,
        scenarioId: "E2E-015",
      },
      order: journey.order,
      outboxCount: 1,
      support: { orderId: journey.order.id, status: "NOT_OPENED" },
    };
    assertSensitiveAbsent(safeSurfaces, sensitiveCanary, "acceptance surfaces");
    expect(encrypted.ciphertext.byteLength).toBeGreaterThan(0);
  });
});

interface OrderJourney {
  readonly audit: AuditSink;
  readonly createInput: Parameters<OrderOrchestrationService["createOrder"]>[0];
  readonly createResult: Awaited<
    ReturnType<OrderOrchestrationService["createOrder"]>
  >;
  readonly order: KeyCoreOrder;
  readonly orders: OrderOrchestrationService;
  readonly priceLocks: PriceLockService;
  readonly pricing: StaticPricingService;
  readonly repository: InMemoryOrderRepository;
}

const createOrderJourney = async (
  name: string,
  options: { readonly operationsControlGate?: OperationsControlGate } = {},
): Promise<OrderJourney> => {
  const quote = syntheticQuote(productId(`product-${name}`));
  const priceLockRepository = new InMemoryPriceLockRepository();
  const pricing = new StaticPricingService(quote);
  const priceLocks = new PriceLockService({
    now: () => now,
    pricing: pricing as unknown as PricingService,
    repository: priceLockRepository,
  });
  const lockResult = await priceLocks.createPriceLock({
    correlationId: correlationId(`lock-${name}`),
    expiresAt: new Date(now.getTime() + 120_000),
    idempotencyKey: `lock-${name}`,
    quote,
  });
  if (!lockResult.lock) throw new Error("Synthetic PriceLock was not created");
  const repository = new InMemoryOrderRepository();
  const audit = new AuditSink();
  const orders = new OrderOrchestrationService({
    audit,
    environment: "CI",
    now: () => new Date(now.getTime() + 1_000),
    operationsControlGate: options.operationsControlGate ?? new AllowAllGate(),
    priceLocks,
    repository,
  });
  const createInput = {
    correlationId: correlationId(`order-${name}`),
    idempotencyKey: `order-${name}`,
    priceLockId: lockResult.lock.id,
    productId: quote.productId,
    quantity: 1,
  } as const;
  const createResult = await orders.createOrder(createInput);
  const order =
    createResult.order ?? syntheticBlockedOrder(name, quote.productId);
  return {
    audit,
    createInput,
    createResult,
    order,
    orders,
    priceLocks,
    pricing,
    repository,
  };
};

const captureAndApprove = async (
  journey: OrderJourney,
): Promise<KeyCoreOrder> => {
  let order = await mustUpdate(
    journey.orders.markAwaitingPayment(command(journey.order)),
  );
  order = await mustUpdate(
    journey.orders.transitionPayment({
      ...command(order),
      paymentStatus: "AUTHORIZED",
    }),
  );
  order = await mustUpdate(
    journey.orders.transitionPayment({
      ...command(order),
      paymentStatus: "CAPTURED",
    }),
  );
  return mustUpdate(
    journey.orders.markRisk({ ...command(order), riskStatus: "APPROVED" }),
  );
};

const completePaidOrder = async (
  journey: OrderJourney,
): Promise<KeyCoreOrder> => {
  let order = await captureAndApprove(journey);
  return completeApprovedOrder(journey, order);
};

const completeApprovedOrder = async (
  journey: OrderJourney,
  capturedOrder: KeyCoreOrder,
): Promise<KeyCoreOrder> => {
  let order = capturedOrder;
  if (order.riskStatus !== "APPROVED") {
    order = await mustUpdate(
      journey.orders.markRisk({ ...command(order), riskStatus: "APPROVED" }),
    );
  }
  order = await mustUpdate(
    journey.orders.markProcurementPending(command(order)),
  );
  order = await mustUpdate(journey.orders.beginProcurement(command(order)));
  order = await mustUpdate(
    journey.orders.recordProcurementResult({
      ...command(order),
      procurementStatus: "SUCCEEDED",
    }),
  );
  order = await mustUpdate(
    journey.orders.markFulfillmentPending(command(order)),
  );
  return mustUpdate(
    journey.orders.recordFulfillmentResult({
      ...command(order),
      fulfillmentStatus: "SUCCEEDED",
    }),
  );
};

const paymentHarness = (journey: OrderJourney) => {
  const verifier = new SyntheticWebhookVerifier();
  return {
    service: new StripePaymentService({
      createLeaseStaleAfterMs: 60_000,
      now: () => now,
      orders: journey.orders,
      repository: new InMemoryPaymentRepository(),
      stripe: new SyntheticStripeProvider(),
      webhookSecret: "whsec_e2e_placeholder_not_a_credential",
      webhookVerifier: verifier,
    }),
    verifier,
  };
};

const paymentIntent = (
  order: KeyCoreOrder,
  status: NormalizedStripePaymentIntent["status"],
): NormalizedStripePaymentIntent => ({
  amount: order.customerAmount,
  createdAt: now,
  currency: order.currency,
  id: `pi_e2e_${order.id}`,
  metadata: stripePaymentMetadata({ orderId: order.id, paymentVersion: 1 }),
  status,
});

const paymentEvent = (
  order: KeyCoreOrder,
  status: "succeeded" | "payment_failed",
): VerifiedStripeEvent => ({
  createdAt: new Date(now.getTime() + 1_000),
  id: `evt_e2e_${status}_${order.id}`,
  paymentIntent: paymentIntent(
    order,
    status === "succeeded" ? "succeeded" : "requires_payment_method",
  ),
  type:
    status === "succeeded"
      ? "payment_intent.succeeded"
      : "payment_intent.payment_failed",
});

class SyntheticStripeProvider implements StripePaymentProviderPort {
  private intent: NormalizedStripePaymentIntent | null = null;

  public async createPaymentIntent(
    input: StripePaymentIntentCreateInput,
  ): Promise<PaymentProviderCreateResult> {
    this.intent = paymentIntent(input.order, "requires_payment_method");
    return { paymentIntent: this.intent, status: "CREATED" };
  }

  public async retrievePaymentIntent(): Promise<PaymentProviderRetrieveResult> {
    return this.intent
      ? { paymentIntent: this.intent, status: "FOUND" }
      : { reasonCode: "PAYMENT_NOT_FOUND", status: "NOT_FOUND" };
  }
}

class SyntheticWebhookVerifier implements StripeWebhookVerifier {
  public event: VerifiedStripeEvent | null = null;

  public async verify(input: {
    readonly signatureHeader?: string;
  }): Promise<VerifiedStripeEvent> {
    if (input.signatureHeader !== "valid-synthetic-signature" || !this.event) {
      throw new Error("Synthetic webhook verification failed");
    }
    return this.event;
  }
}

const command = (order: KeyCoreOrder) => ({
  correlationId: correlationId(`transition-${order.recordVersion}`),
  expectedVersion: order.recordVersion,
  orderId: order.id,
});

const mustUpdate = async (
  resultPromise: Promise<{
    readonly status: string;
    readonly order?: KeyCoreOrder;
  }>,
): Promise<KeyCoreOrder> => {
  const result = await resultPromise;
  if (result.status !== "UPDATED" || !result.order) {
    throw new Error("Expected deterministic order transition");
  }
  return result.order;
};

const syntheticQuote = (targetProductId: ProductId): SellPriceQuote => ({
  acquisitionCost: money(1_000n, eur),
  calculatedAt: now,
  currency: eur,
  expectedProfit: money(300n, eur),
  hardMinimumProfit: money(50n, eur),
  hardMinimumSellPrice: money(100n, eur),
  knownFees: money(0n, eur),
  marginBasisPoints: 2_307n,
  markupBasisPoints: 3_000n,
  offerId: "synthetic-offer" as SellPriceQuote["offerId"],
  preRoundingPrice: money(1_300n, eur),
  pricingPolicyRecordVersion: 1,
  pricingPolicyVersion: "pricing-policy-v1",
  productId: targetProductId,
  sellPrice: money(1_300n, eur),
  sourceFingerprint: "synthetic-source-fingerprint",
  status: "QUOTED",
  taxAmount: money(0n, eur),
  taxPolicyVersion: "synthetic-tax-v1",
});

class StaticPricingService {
  public constructor(private readonly quote: SellPriceQuote) {}

  public async quoteProduct(): Promise<ProductPriceSelection> {
    return {
      productId: this.quote.productId,
      quotes: [this.quote],
      selectedQuote: this.quote,
      status: "QUOTED",
    };
  }
}

class AllowAllGate implements OperationsControlGate {
  public async evaluate(): Promise<{ readonly status: "ALLOWED" }> {
    return { status: "ALLOWED" };
  }
}

const operationsGate = (
  options: {
    readonly paused?: OperationsCapability;
    readonly unavailableMode?: "MISSING" | "MALFORMED";
  } = {},
) => {
  const repository = new AcceptanceOperationsControlRepository(options);
  return {
    gate: new OperationsControlService(repository, { now: () => now }),
    repository,
  };
};

class AcceptanceOperationsControlRepository implements OperationsControlRepository {
  private readonly controls = new Map<
    OperationsCapability,
    OperationsControl
  >();

  public constructor(
    private readonly options: {
      readonly paused?: OperationsCapability;
      readonly unavailableMode?: "MISSING" | "MALFORMED";
    },
  ) {
    for (const capability of [
      "GLOBAL_COMMERCE_MUTATIONS",
      "CHECKOUT_CREATE",
      "PROCUREMENT_CREATE",
      "SUPPLIER_KEY_RETRIEVAL",
      "CUSTOMER_KEY_DELIVERY",
      "SUPPLIER_CLAIM_SUBMISSION",
    ] as const) {
      const paused = capability === options.paused;
      this.controls.set(capability, {
        capability,
        createdAt: now,
        reasonCode: paused ? "MANUAL_OPERATIONS_PAUSE" : null,
        recordVersion: 1,
        state: paused ? "PAUSED" : "ENABLED",
        updatedAt: now,
      });
    }
  }

  public async findControl(
    capability: OperationsCapability,
  ): Promise<OperationsControl | null> {
    if (this.options.unavailableMode === "MISSING") return null;
    const control = this.controls.get(capability) ?? null;
    return this.options.unavailableMode === "MALFORMED" && control
      ? ({ ...control, recordVersion: 0 } as OperationsControl)
      : control;
  }

  public async changeControl(): Promise<never> {
    throw new Error("Acceptance controls are immutable");
  }

  public pause(capability: OperationsCapability): void {
    const current = this.controls.get(capability);
    if (!current) throw new Error("Acceptance control missing");
    this.controls.set(capability, {
      ...current,
      reasonCode: "MANUAL_OPERATIONS_PAUSE",
      recordVersion: current.recordVersion + 1,
      state: "PAUSED",
      updatedAt: new Date(now.getTime() + 1_000),
    });
  }
}

const procurementHarness = (
  journey: OrderJourney,
  options: {
    readonly operationsControlGate?: OperationsControlGate;
    readonly reconciliationOutcomes?: readonly (
      "STILL_AMBIGUOUS" | "RESOLVED"
    )[];
  } = {},
) => {
  const repository = new InMemoryProcurementOperationRepository();
  const fulfillments = new InMemoryFulfillmentRepository();
  const original = new AcceptanceSupplier(
    supplierId("mock-supplier"),
    "AMBIGUOUS",
    options.reconciliationOutcomes ?? ["RESOLVED"],
  );
  const fallback = new AcceptanceSupplier(
    supplierId("mock-fallback"),
    "FULFILLED",
    ["RESOLVED"],
  );
  const registry = new SupplierRegistry();
  registry.register(original as unknown as SupplierPort);
  registry.register(fallback as unknown as SupplierPort);
  const candidates = [
    procurementCandidate(original.identity.supplierId, "primary"),
    procurementCandidate(fallback.identity.supplierId, "fallback"),
  ];
  const service = new SupplierProcurementService({
    audit: journey.audit,
    environment: "CI",
    executionLeaseStaleAfterMs: 60_000,
    executionMode: "FAKE_SUPPLIER_ONLY",
    now: () => now,
    operationsControlGate: options.operationsControlGate ?? new AllowAllGate(),
    orders: journey.orders,
    priceLocks: journey.priceLocks,
    pricing: journey.pricing as unknown as PricingService,
    repository,
    routing: {
      selectSupplier: async () => ({
        correlationId: correlationId("e2e-procurement-routing"),
        evaluatedAt: now,
        evaluatedCandidates: candidates,
        failures: [],
        policyVersion: "e2e-routing-v1",
        rejectionReasons: [],
        selectedCandidate: candidates[0],
        status: "SELECTED",
      }),
    } as unknown as SupplierRoutingService,
    routingPolicy: {
      allowDegradedSuppliers: false,
      allowReviewRequired: false,
      allowUnknownHealth: false,
      allowedCurrencies: [eur],
      maxPriceAgeMs: 300_000,
      requiredCapabilities: ["PURCHASE", "PRICE_LOOKUP", "REGION_EVIDENCE"],
      requiredHealth: "HEALTHY",
      version: "e2e-routing-v1",
    } as SupplierRoutingPolicy,
    suppliers: registry,
  });
  return { fallback, fulfillments, original, repository, service };
};

class AcceptanceSupplier {
  public purchaseDispatchCount = 0;
  public reconciliationLookupCount = 0;
  private readonly reconciliationOutcomes: ("STILL_AMBIGUOUS" | "RESOLVED")[];
  public readonly capabilities = {
    supportsDelayedFulfillment: true,
    supportsDeltaCatalog: false,
    supportsFullCatalog: false,
    supportsHealthRateLimitInfo: false,
    supportsKeyRetrieval: false,
    supportsPriceLookup: true,
    supportsPurchase: true,
    supportsPurchaseStatusReconciliation: true,
    supportsRefundClaims: false,
    supportsRegionEvidence: true,
  };
  public readonly identity;

  public constructor(
    supplier: ReturnType<typeof supplierId>,
    private readonly purchaseState: "AMBIGUOUS" | "FULFILLED",
    reconciliationOutcomes: readonly ("STILL_AMBIGUOUS" | "RESOLVED")[],
  ) {
    this.identity = {
      contractVersion: { major: 1, minor: 0 },
      displayName: "Synthetic Acceptance Supplier",
      supplierId: supplier,
    };
    this.reconciliationOutcomes = [...reconciliationOutcomes];
  }

  public async submitPurchase() {
    this.purchaseDispatchCount += 1;
    return {
      acceptedAt: now,
      state: this.purchaseState,
      supplierPurchaseReference: "synthetic-ambiguous-order",
    } as const;
  }

  public async reconcilePurchase() {
    this.reconciliationLookupCount += 1;
    const outcome = this.reconciliationOutcomes.shift() ?? "RESOLVED";
    return {
      observedAt: now,
      outcome,
      reason:
        outcome === "RESOLVED"
          ? "SYNTHETIC_PURCHASE_OBSERVED"
          : "SYNTHETIC_PURCHASE_STILL_AMBIGUOUS",
    } as const;
  }
}

const procurementCandidate = (
  supplier: ReturnType<typeof supplierId>,
  suffix: string,
): SupplierRoutingCandidate =>
  ({
    offer: {
      offer: { offerId: offerId("synthetic-offer") },
    },
    price: money(1_000n, eur),
    status: "ELIGIBLE",
    supplierId: supplier,
    supplierOfferId: supplierOfferId(`e2e-${suffix}-offer`),
    supplierProductId: supplierProductId(`e2e-${suffix}-product`),
  }) as SupplierRoutingCandidate;

const requiredOperation = (operationIdValue: string | undefined): string => {
  if (!operationIdValue) throw new Error("Acceptance operation missing");
  return operationIdValue;
};

class AuditSink implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const createVerifiedOwnedIdentity = async (order: KeyCoreOrder) => {
  const repository = new InMemoryCustomerOrderIdentityRepository();
  repository.addOrder({
    checkoutEmailNormalized: "account@example.test",
    customerId: null,
    fulfillmentStatus: order.fulfillmentStatus,
    orderId: order.id,
    paymentStatus: order.paymentStatus,
    procurementStatus: order.procurementStatus,
    recordVersion: 1,
    status: order.status,
    updatedAt: now,
  });
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new TrustedEmailAuthority(),
    now: () => now,
    orderOwnershipAuthority: new TrustedOwnershipAuthority(),
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId("e2e-001-customer"),
    email: "account@example.test",
  });
  if (created.status === "INVALID_EMAIL")
    throw new Error("Customer fixture invalid");
  await service.markEmailVerified({
    correlationId: correlationId("e2e-001-verify"),
    customerId: created.customer.id,
    expectedCustomerVersion: created.customer.recordVersion,
  });
  const ownership = await service.bindOrderOwnership({
    correlationId: correlationId("e2e-001-own"),
    customerId: created.customer.id,
    expectedOrderVersion: 1,
    orderId: order.id,
  });
  return { customer: created.customer.id, ownership, repository };
};

const exerciseSecureCustomerDelivery = async (
  order: KeyCoreOrder,
  identity: Awaited<ReturnType<typeof createVerifiedOwnedIdentity>>,
  options: {
    readonly operationsControlGate?: OperationsControlGate;
    readonly paused?: boolean;
  } = {},
) => {
  const fulfillmentRepository = new InMemoryFulfillmentRepository();
  const deliveryRepository = new InMemoryCustomerKeyDeliveryRepository(
    fulfillmentRepository,
  );
  const provider = new CountingKeyProvider(syntheticKeyProvider());
  const fulfillment: FulfillmentOperation = {
    approvalExpiresAt: new Date(now.getTime() + 300_000),
    controlledProcurementApprovalId: null,
    correlationId: correlationId("e2e-001-fulfillment"),
    createdAt: now,
    deliveryState: "NOT_READY",
    expectedQuantity: 1,
    externalSupplierOrderId: "synthetic-e2e-supplier-order",
    id: "10000000-0000-4000-8000-000000000101",
    orderId: order.id,
    procurementOperationId: "10000000-0000-4000-8000-000000000102",
    recordVersion: 1,
    retrievalExecutionToken: "10000000-0000-4000-8000-000000000103",
    retrievalStartedAt: now,
    retrievalState: "IN_FLIGHT",
    status: "RETRIEVAL_IN_FLIGHT",
    supplierId: supplierId("mock-supplier"),
    supplierItemReference: "synthetic-e2e-item",
    tokenHash: "a".repeat(64),
    updatedAt: now,
  };
  const material = await encryptFulfillmentSecret(
    Buffer.from(sensitiveCanary, "utf8"),
    fulfillmentEncryptionContext(fulfillment),
    provider,
  );
  await fulfillmentRepository.createIdempotent({ operation: fulfillment, now });
  await fulfillmentRepository.markRetrieved({
    executionToken: fulfillment.retrievalExecutionToken ?? "",
    fulfillmentId: fulfillment.id,
    material,
    now,
  });
  const retrieved = await fulfillmentRepository.findById(fulfillment.id);
  if (!retrieved?.encryptedSecretId) {
    throw new Error("Encrypted E2E fulfillment was not persisted");
  }

  identity.repository.addFulfillment({
    deliveryState: "PENDING",
    encryptedSecretId: retrieved.encryptedSecretId,
    fulfillmentId: retrieved.id,
    orderId: order.id,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  });
  const accountRepository = new InMemoryCustomerAccountReadRepository();
  accountRepository.addOrder({
    activation: null,
    createdAt: order.createdAt,
    currency: order.currency,
    customerId: identity.customer,
    fulfillment: {
      deliveredAt: null,
      deliveryState: "PENDING",
      fulfillmentId: retrieved.id,
      hasEncryptedSecret: true,
      orderId: order.id,
      retrievedAt: now,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    },
    fulfillmentStatus: "PENDING",
    invoice: { downloadAvailable: true, status: "AVAILABLE" },
    orderId: order.id,
    paymentStatus: order.paymentStatus,
    procurementStatus: order.procurementStatus,
    productTitle: "Synthetic E2E Product",
    refundStatus: order.refundStatus,
    status: "FULFILLMENT_PENDING",
    total: order.customerAmount,
    updatedAt: now,
  });
  const principalProvider = new FixedPrincipalProvider(
    principal(identity.customer),
  );
  const deliveryPort = new CanaryDeliveryPort();
  const deliveryService = new CustomerKeyDeliveryService({
    approvalTtlMs: 300_000,
    deliveryLeaseStaleAfterMs: 60_000,
    deliveryPort,
    deliveryRepository,
    environment: "CI",
    fulfillmentRepository,
    keyManagementProvider: provider,
    now: () => now,
    operationsControlGate: options.operationsControlGate ?? new AllowAllGate(),
    orderAuthorization: new PersistedCustomerOrderAuthorizationPort({
      environment: "CI",
      principalProvider,
      repository: identity.repository,
    }),
    protectedFulfillmentIds: [],
  });
  const access = new CustomerKeyAccessService({
    accountRepository,
    deliveryService,
    environment: "CI",
    now: () => now,
  });
  await expect(
    access.prepareKeyAccess({
      correlationId: correlationId("e2e-001-denied-key-access"),
      fulfillmentReference: retrieved.id,
      orderId: order.id,
      principal: principal(customerId("10000000-0000-4000-8000-000000000199")),
    }),
  ).resolves.toEqual({ code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" });
  const prepared = await access.prepareKeyAccess({
    correlationId: correlationId("e2e-001-key-access"),
    fulfillmentReference: retrieved.id,
    orderId: order.id,
    principal: principal(identity.customer),
  });
  if (prepared.status !== "AUTHORIZED") {
    throw new Error("Synthetic key access was not authorized");
  }
  const executeInput = {
    correlationId: correlationId("e2e-001-key-delivery"),
    deliveryApprovalId: prepared.deliveryApprovalId,
    deliveryCapability: prepared.deliveryCapability,
    fulfillmentReference: retrieved.id,
    orderId: order.id,
    principal: principal(identity.customer),
  } as const;
  const executed = await access.executeKeyAccess(executeInput);
  if (options.paused) {
    expect(executed).toEqual({
      code: "KEY_ACCESS_NOT_AVAILABLE",
      status: "DENIED",
    });
  } else {
    expect(executed).toMatchObject({ status: "DELIVERED" });
  }
  const replay = options.paused
    ? null
    : await access.executeKeyAccess(executeInput);
  return {
    deliveryCount: deliveryPort.deliveryCount,
    encryptedSecretCount: fulfillmentRepository.secrets.size,
    executeStatus: executed.status,
    replayStatus: replay?.status ?? null,
    safeSurface: {
      approvalCount: deliveryRepository.approvals.size,
      attemptCount: deliveryRepository.attempts.size,
      deliveryCount: deliveryPort.deliveryCount,
      fulfillmentId: retrieved.id,
      orderId: order.id,
    },
    unwrapCount: provider.unwrapCount,
  };
};

class CountingKeyProvider implements KeyManagementProvider {
  public unwrapCount = 0;

  public constructor(private readonly delegate: KeyManagementProvider) {}

  public activeMasterKeyVersion(): Promise<string> {
    return this.delegate.activeMasterKeyVersion();
  }

  public wrapDataKey(request: { readonly dataKey: Uint8Array }) {
    return this.delegate.wrapDataKey(request);
  }

  public unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }): Promise<Uint8Array> {
    this.unwrapCount += 1;
    return this.delegate.unwrapDataKey(request);
  }

  public getKeyVersionMetadata(keyVersion: string) {
    return this.delegate.getKeyVersionMetadata(keyVersion);
  }
}

class FixedPrincipalProvider implements AuthenticatedCustomerPrincipalProvider {
  public constructor(
    private readonly current: AuthenticatedCustomerPrincipal | null,
  ) {}

  public async currentPrincipal(): Promise<AuthenticatedCustomerPrincipal | null> {
    return this.current;
  }
}

class CanaryDeliveryPort implements CustomerKeyDeliveryPort {
  public deliveryCount = 0;

  public async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
  }): Promise<CustomerKeyDeliveryPortResult> {
    const expected = createHash("sha256").update(sensitiveCanary).digest("hex");
    const observed = createHash("sha256").update(input.plaintext).digest("hex");
    if (observed !== expected)
      throw new Error("Synthetic delivery canary mismatch");
    this.deliveryCount += 1;
    return {
      channel: "FAKE",
      deliveredAt: now,
      deliveryReference: `synthetic-delivery-${this.deliveryCount}`,
      status: "DELIVERED",
    };
  }
}

const exercisePausedSupplierKeyRetrieval = async (
  operationsControlGate: OperationsControlGate,
) => {
  const repository = new InMemoryFulfillmentRepository();
  const keyRetrieval = new CountingSupplierKeyRetrieval();
  const service = new SecureKeyFulfillmentService({
    approvalTtlMs: 300_000,
    controlledKeyRetrievalEnabled: true,
    controlledKeyRetrievalMode: "CONTROLLED_VERIFICATION_ONE_TIME",
    environment: "CI",
    keyManagementProvider: syntheticKeyProvider(),
    keyRetrieval,
    now: () => now,
    operationsControlGate,
    procurementEvidence: new SyntheticProcurementEvidence(),
    repository,
    retrievalLeaseStaleAfterMs: 60_000,
  });
  const prepared = await service.prepareControlledRetrieval({
    controlledProcurementApprovalId: "10000000-0000-4000-8000-000000000121",
    correlationId: correlationId("e2e-012-key-prepare"),
  });
  const result = await service.executeControlledRetrieval({
    correlationId: correlationId("e2e-012-key-execute"),
    executionToken: prepared.oneTimeExecutionToken ?? "",
    fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
  });
  const operation = await repository.findById(
    prepared.fulfillmentApprovalId ?? "",
  );
  return {
    encryptedSecretCount: repository.secrets.size,
    retrievalCallCount: keyRetrieval.calls,
    retrievalState: operation?.retrievalState,
    status: result.status,
  };
};

class SyntheticProcurementEvidence implements FulfillmentProcurementEvidencePort {
  public async getControlledProcurementEvidence(approvalId: string) {
    return {
      controlledProcurementApprovalId: approvalId,
      expectedQuantity: 1,
      externalSupplierOrderId: "synthetic-e2e-procurement-order",
      status: "CONFIRMED" as const,
      supplierId: supplierId("kinguin"),
    };
  }
}

class CountingSupplierKeyRetrieval implements SupplierKeyRetrievalPort {
  public calls = 0;

  public async retrievePurchasedKeys() {
    this.calls += 1;
    return {
      reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET" as const,
      status: "PENDING" as const,
    };
  }
}

const exercisePausedSupplierClaim = async (
  operationsControlGate: OperationsControlGate,
) => {
  const repository = new InMemorySupplierClaimRepository();
  const claimOrderId = orderId("10000000-0000-4000-8000-000000000131");
  const supportCaseId = "10000000-0000-4000-8000-000000000132";
  const procurementOperationId = "10000000-0000-4000-8000-000000000133";
  const fulfillmentId = "10000000-0000-4000-8000-000000000134";
  repository.setOrder({ orderId: claimOrderId });
  repository.setSupportCase({
    category: "ACTIVATION_PROBLEM",
    id: supportCaseId,
    orderId: claimOrderId,
    status: "OPEN",
  });
  repository.setProcurement({
    dispatchState: "DISPATCH_CONFIRMED",
    externalSupplierOrderId: "synthetic-e2e-supplier-order",
    id: procurementOperationId,
    orderId: claimOrderId,
    status: "SUCCEEDED",
    supplierId: "mock-supplier",
  });
  repository.setFulfillment({
    deliveryState: "PENDING",
    id: fulfillmentId,
    orderId: claimOrderId,
    procurementOperationId,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  });
  const submissionPort = new CountingSupplierClaimSubmissionPort();
  const service = new SupplierClaimService({
    authority: new TrustedSupplierClaimAuthority(),
    environment: "CI",
    now: () => now,
    operationsControlGate,
    repository,
    submissionPort,
  });
  const created = await service.createClaim({
    category: "KEY_NOT_WORKING",
    correlationId: correlationId("e2e-012-claim-create"),
    fulfillmentId,
    idempotencyKey: "e2e-012-supplier-claim",
    orderId: claimOrderId,
    procurementOperationId,
    source: "SUPPORT",
    supportCaseId,
  });
  if (created.status === "FAILED") {
    throw new Error("Synthetic supplier claim creation failed");
  }
  const claimId = created.detail.claim.id;
  await service.transitionClaim({
    claimId,
    correlationId: correlationId("e2e-012-claim-review"),
    expectedVersion: 1,
    nextStatus: "UNDER_REVIEW",
  });
  await service.transitionClaim({
    claimId,
    correlationId: correlationId("e2e-012-claim-ready"),
    expectedVersion: 2,
    nextStatus: "READY_FOR_SUBMISSION",
  });
  await service.prepareSubmission({
    claimId,
    correlationId: correlationId("e2e-012-claim-prepare"),
  });
  const result = await service.executeSubmission({
    claimId,
    correlationId: correlationId("e2e-012-claim-submit"),
    expectedSubmissionVersion: 1,
  });
  const persisted = await repository.findClaim(claimId);
  return {
    dispatchCount: submissionPort.calls,
    status: result.status,
    submissionStatus: persisted?.submission?.status,
  };
};

class TrustedSupplierClaimAuthority implements SupplierClaimAuthorityPort {
  public async authorize() {
    return {
      actorReference: "operator:e2e-acceptance",
      status: "AUTHORIZED" as const,
    };
  }
}

class CountingSupplierClaimSubmissionPort implements SupplierClaimSubmissionPort {
  public calls = 0;

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async submit(): Promise<{
    readonly responseType: "ACCEPTED";
    readonly status: "CONFIRMED";
    readonly supplierClaimReference: string;
  }> {
    this.calls += 1;
    return {
      responseType: "ACCEPTED",
      status: "CONFIRMED",
      supplierClaimReference: "synthetic-claim-reference",
    };
  }
}

class TrustedEmailAuthority implements EmailVerificationAuthorityPort {
  public async verifiedEmailEvidence(input: {
    readonly customerId: CustomerId;
    readonly emailNormalized: string;
    readonly correlationId: CorrelationId;
  }) {
    return {
      evidence: {
        customerId: input.customerId,
        emailNormalized: input.emailNormalized,
        provider: "TEST" as const,
        providerEvidenceId: `e2e-email-${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class TrustedOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      actorId: "e2e-checkout",
      actorType: "SERVICE" as const,
      providerEvidenceId: `e2e-ownership-${input.orderId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

const guestClaimHarness = () => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const claimRepository = new InMemoryGuestOrderClaimRepository(
    identityRepository,
  );
  const audit = new AuditSink();
  const delivery = new FakeGuestOrderClaimDeliveryPort();
  const claims = new GuestOrderClaimService({
    audit,
    claimTtlMs: 604_800_000,
    delivery,
    issuanceAuthority: new PersistedGuestOrderClaimIssuanceAuthority(
      identityRepository,
    ),
    now: () => now,
    repository: claimRepository,
    tokenFactory: () => syntheticClaimCode,
  });
  const registration = new CustomerRegistrationService({
    challengeRepository: new InMemoryCustomerRegistrationChallengeRepository(
      identityRepository,
    ),
    claimAuthority: new PersistedGuestOrderClaimAuthority({
      now: () => now,
      repository: claimRepository,
    }),
    delivery: new FakeCustomerEmailVerificationDeliveryPort(),
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      now: () => now,
      repository: identityRepository,
    }),
    now: () => now,
  });
  return {
    audit,
    claimRepository,
    claims,
    delivery,
    identityRepository,
    registration,
  };
};

const registerVerifiedCustomer = async (
  harness: ReturnType<typeof guestClaimHarness>,
  email: string,
): Promise<CustomerId> => {
  await harness.registration.register({
    correlationId: correlationId(`register-${email}`),
    email,
  });
  const customer =
    await harness.identityRepository.findCustomerByNormalizedEmail(email);
  if (!customer) throw new Error("Synthetic registration failed");
  const identity = new CustomerOrderIdentityService({
    emailVerificationAuthority: new TrustedEmailAuthority(),
    now: () => now,
    repository: harness.identityRepository,
  });
  await identity.markEmailVerified({
    correlationId: correlationId(`verify-${email}`),
    customerId: customer.id,
    expectedCustomerVersion: customer.recordVersion,
  });
  return customer.id;
};

const principal = (id: CustomerId): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance: "AUTHENTICATED", provider: "TEST" },
  customerId: id,
});

class TrustedFraudReviewAuthority implements FraudManualReviewAuthorityPort {
  public async authorizeResolution() {
    return { operatorReference: "operator:e2e", status: "AUTHORIZED" as const };
  }
}

const riskOrder = (
  id: string,
  overrides: Partial<KeyCoreOrder>,
): KeyCoreOrder => ({
  checkoutEmailNormalized: null,
  correlationId: correlationId(`risk-${id}`),
  createdAt: now,
  currency: eur,
  customerAmount: money(1_300n, eur),
  customerId: customerId("70000000-0000-4000-8000-000000000001"),
  fulfillmentStatus: "NOT_STARTED",
  id: orderId(id),
  idempotencyFingerprint: `risk-fingerprint-${id}`,
  idempotencyKey: `risk-${id}`,
  paymentStatus: "CAPTURED",
  priceLockId: "70000000-0000-4000-8000-000000000002",
  procurementStatus: "NOT_STARTED",
  productId: productId(`risk-product-${id}`),
  quantity: 1,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "NOT_EVALUATED",
  status: "PAYMENT_CAPTURED",
  updatedAt: now,
  ...overrides,
});

class TrustedSupportAuthority implements SupportOperatorAuthorityPort {
  public async authorize() {
    return { operatorReference: "operator:e2e", status: "AUTHORIZED" as const };
  }
}

const accountOrderProjection = (
  owner: CustomerId,
): CustomerAccountOrderProjection => ({
  activation: null,
  createdAt: now,
  currency: eur,
  customerId: owner,
  fulfillment: null,
  fulfillmentStatus: "SUCCEEDED",
  invoice: {
    downloadAvailable: true,
    invoiceReference: "KR-E2E-0001",
    issuedAt: now,
    status: "AVAILABLE",
  },
  orderId: orderId("14000000-0000-4000-8000-000000000016"),
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Synthetic E2E Product",
  refundStatus: "NOT_REQUESTED",
  status: "COMPLETED",
  total: money(1_300n, eur),
  updatedAt: now,
});

const encryptSyntheticCanary = async (id: OrderId) => {
  return encryptProductKeyMaterial(
    Buffer.from(sensitiveCanary, "utf8"),
    { orderLineId: orderLineId(id) },
    syntheticKeyProvider(),
  );
};

const syntheticKeyProvider = () =>
  new DevelopmentKeyManagementProvider({
    environmentName: "ci",
    masterKeyMaterialBase64: Buffer.alloc(32, 7).toString("base64"),
    masterKeyVersion: "e2e-master-v1",
  });

const assertSensitiveAbsent = (
  value: unknown,
  marker: string,
  surface: string,
): void => {
  if (safeSerialize(value).includes(marker)) {
    throw new Error(`Sensitive canary detected in ${surface}`);
  }
};

const safeSerialize = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );

const syntheticBlockedOrder = (
  name: string,
  targetProductId: ProductId,
): KeyCoreOrder => ({
  checkoutEmailNormalized: null,
  correlationId: correlationId(`blocked-${name}`),
  createdAt: now,
  currency: eur,
  customerAmount: money(1_300n, eur),
  customerId: null,
  fulfillmentStatus: "NOT_STARTED",
  id: orderId(randomUUID()),
  idempotencyFingerprint: createHash("sha256").update(name).digest("hex"),
  idempotencyKey: `blocked-${name}`,
  paymentStatus: "NOT_STARTED",
  priceLockId: randomUUID(),
  procurementStatus: "NOT_STARTED",
  productId: targetProductId,
  quantity: 1,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "NOT_EVALUATED",
  status: "CREATED",
  updatedAt: now,
});

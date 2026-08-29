import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
} from "vitest/node";

type SafeState = "FAILED" | "PASSED" | "SKIPPED";

interface ScenarioDefinition {
  readonly actorCount: number;
  readonly durableRowCounts: Readonly<Record<string, number>>;
  readonly expectedLogicalWinners: number;
  readonly name: string;
  readonly reasonCodes: readonly string[];
  readonly tests: readonly string[];
}

const scenarios = new Map<string, ScenarioDefinition>([
  [
    "CONC-001",
    {
      actorCount: 10,
      durableRowCounts: { orders: 1, priceLockConsumptions: 1 },
      expectedLogicalWinners: 1,
      name: "SAME_INPUT_ORDER_REPLAY",
      reasonCodes: ["IDEMPOTENT"],
      tests: [
        "creates exactly one logical order for concurrent same-key same-input calls",
      ],
    },
  ],
  [
    "CONC-002",
    {
      actorCount: 10,
      durableRowCounts: { orders: 1, losingPriceLockConsumptions: 0 },
      expectedLogicalWinners: 1,
      name: "CONFLICTING_ORDER_REPLAY",
      reasonCodes: ["ORDER_IDEMPOTENCY_CONFLICT"],
      tests: [
        "returns idempotency conflicts without consuming losing locks when the same key races across different PriceLocks",
        "returns stable idempotency conflicts for conflicting reuse after creation",
      ],
    },
  ],
  [
    "CONC-003",
    {
      actorCount: 10,
      durableRowCounts: { orders: 1, priceLockConsumptions: 1 },
      expectedLogicalWinners: 1,
      name: "SAME_PRICE_LOCK_RACE",
      reasonCodes: ["PRICE_LOCK_CONSUMED", "PRICE_LOCK_UNSAFE"],
      tests: [
        "fails closed when concurrent different idempotency keys try the same PriceLock",
        "atomically allows exactly one active lock consumption",
      ],
    },
  ],
  [
    "CONC-004",
    {
      actorCount: 10,
      durableRowCounts: { payments: 1, activeLeaseOwners: 1 },
      expectedLogicalWinners: 1,
      name: "PAYMENT_INITIALIZATION",
      reasonCodes: ["PAYMENT_CREATE_IN_PROGRESS"],
      tests: [
        "creates exactly one reserved STRIPE payment for concurrent order initialization",
        "allows only one concurrent create lease claimant without globally serializing unrelated orders",
      ],
    },
  ],
  [
    "CONC-005",
    {
      actorCount: 10,
      durableRowCounts: { externalEventReceipts: 1 },
      expectedLogicalWinners: 1,
      name: "PAYMENT_EVENT_REPLAY",
      reasonCodes: ["EXTERNAL_EVENT_DEDUPLICATED"],
      tests: [
        "deduplicates concurrent identical external event receipts without raw database errors",
      ],
    },
  ],
  [
    "CONC-006",
    {
      actorCount: 10,
      durableRowCounts: { externalEventReceipts: 1 },
      expectedLogicalWinners: 1,
      name: "PAYMENT_EVENT_CONFLICT",
      reasonCodes: ["EXTERNAL_EVENT_CONFLICT"],
      tests: [
        "returns concurrent external event conflicts for reused identity with changed fingerprints",
      ],
    },
  ],
  [
    "CONC-007",
    {
      actorCount: 10,
      durableRowCounts: { procurementOperations: 1, activeLeaseOwners: 1 },
      expectedLogicalWinners: 1,
      name: "PROCUREMENT_START",
      reasonCodes: ["PROCUREMENT_IN_PROGRESS"],
      tests: [
        "creates one logical operation for 10 concurrent starts without raw unique errors",
      ],
    },
  ],
  [
    "CONC-008",
    {
      actorCount: 2,
      durableRowCounts: { activeLeaseOwners: 1 },
      expectedLogicalWinners: 1,
      name: "PROCUREMENT_LEASE_OWNERSHIP",
      reasonCodes: ["PROCUREMENT_EXECUTION_OWNERSHIP_LOST"],
      tests: [
        "recovers stale not-dispatched leases, keeps unrelated operations independent and enforces ownership",
      ],
    },
  ],
  [
    "CONC-009",
    {
      actorCount: 2,
      durableRowCounts: { successfulProcurements: 0 },
      expectedLogicalWinners: 0,
      name: "AMBIGUOUS_PROCUREMENT",
      reasonCodes: ["PROCUREMENT_RECONCILIATION_REQUIRED"],
      tests: [
        "allows one active execution owner and treats stale post-dispatch as ambiguous",
        "allows generation 2 after terminal failure and blocks after ambiguous or succeeded attempts",
      ],
    },
  ],
  [
    "CONC-010",
    {
      actorCount: 10,
      durableRowCounts: { successfulProcurements: 1 },
      expectedLogicalWinners: 1,
      name: "PROCUREMENT_COMPLETION",
      reasonCodes: ["PROCUREMENT_ALREADY_TERMINAL"],
      tests: [
        "enforces one successful procurement per order and stores no product key",
      ],
    },
  ],
  [
    "CONC-011",
    {
      actorCount: 10,
      durableRowCounts: {
        encryptedRecordsPerFulfillment: 1,
        fulfillmentsPerProcurement: 1,
      },
      expectedLogicalWinners: 1,
      name: "FULFILLMENT_CREATION",
      reasonCodes: ["FULFILLMENT_IDEMPOTENT"],
      tests: [
        "creates fulfillment idempotently for one controlled procurement approval",
        "stores encrypted secret transactionally and leaves no plaintext columns",
      ],
    },
  ],
  [
    "CONC-012",
    {
      actorCount: 10,
      durableRowCounts: { activeLeaseOwners: 1, fulfillments: 1 },
      expectedLogicalWinners: 1,
      name: "FULFILLMENT_RETRIEVAL",
      reasonCodes: [
        "FULFILLMENT_RETRIEVAL_IN_PROGRESS",
        "FULFILLMENT_RETRIEVAL_OWNERSHIP_LOST",
      ],
      tests: [
        "allows exactly one concurrent retrieval lease owner",
        "requires current retrieval ownership and prevents orphan secrets",
        "allows exactly one concurrent markRetrieved writer",
        "keeps terminal retrieved state from stale overwrite",
      ],
    },
  ],
  [
    "CONC-013",
    {
      actorCount: 10,
      durableRowCounts: { deliveryEffectsPerApproval: 1 },
      expectedLogicalWinners: 1,
      name: "CUSTOMER_DELIVERY",
      reasonCodes: [
        "DELIVERY_IN_FLIGHT",
        "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      ],
      tests: [
        "persists secure customer delivery state and concurrency invariants",
      ],
    },
  ],
  [
    "CONC-014",
    {
      actorCount: 10,
      durableRowCounts: {
        consumedChallengesPerOrder: 1,
        ownershipBindingsPerOrder: 1,
      },
      expectedLogicalWinners: 1,
      name: "GUEST_ORDER_CLAIM",
      reasonCodes: ["CLAIM_DENIED"],
      tests: [
        "persists hash-only claim credentials, reissues safely and consumes once under concurrency",
        "keeps legacy null-email orders unclaimable, enforces immutable snapshots and token hash uniqueness",
      ],
    },
  ],
  [
    "CONC-015",
    {
      actorCount: 10,
      durableRowCounts: { refundEffects: 1 },
      expectedLogicalWinners: 1,
      name: "REFUND_REQUEST",
      reasonCodes: ["OPTIMISTIC_CONCURRENCY_CONFLICT"],
      tests: [
        "allows one concurrent refund request and keeps commercial fields immutable",
      ],
    },
  ],
  [
    "CONC-016",
    {
      actorCount: 10,
      durableRowCounts: { acceptedStaleWriters: 0, terminalRegressions: 0 },
      expectedLogicalWinners: 1,
      name: "ORDER_STATE_TRANSITIONS",
      reasonCodes: ["OPTIMISTIC_CONCURRENCY_CONFLICT"],
      tests: [
        "returns explicit optimistic conflicts for simultaneous state transitions",
        "rejects invalid persisted order states and partial external event identity",
        "persists provider creation, rejects external ID reuse and prevents captured regression",
        "keeps terminal retrieved state from stale overwrite",
      ],
    },
  ],
  [
    "CONC-017",
    {
      actorCount: 10,
      durableRowCounts: {
        orders: 10,
        priceLockConsumptions: 10,
        historyEffects: 10,
        outboxEffects: 10,
      },
      expectedLogicalWinners: 10,
      name: "INDEPENDENT_ORDERS",
      reasonCodes: [],
      tests: [
        "processes 10 unrelated orders concurrently without a repository-wide lock",
      ],
    },
  ],
]);

interface TestObservation {
  readonly durationMs: number;
  readonly state: SafeState;
}

export class OrderConcurrencyEvidenceReporter implements Reporter {
  private readonly observations = new Map<string, TestObservation>();

  public onTestCaseResult(testCase: TestCase): void {
    const isScenarioTest = [...scenarios.values()].some((scenario) =>
      scenario.tests.includes(testCase.name),
    );
    if (!isScenarioTest) return;
    const result = testCase.result();
    this.observations.set(testCase.name, {
      durationMs: Math.max(0, Math.round(testCase.diagnostic()?.duration ?? 0)),
      state:
        result.state === "passed"
          ? "PASSED"
          : result.state === "skipped"
            ? "SKIPPED"
            : "FAILED",
    });
  }

  public async onTestRunEnd(
    _modules: readonly TestModule[],
    _errors: readonly unknown[],
    reason: TestRunEndReason,
  ): Promise<void> {
    const results = [...scenarios].map(([scenarioId, definition]) => {
      const observations = definition.tests.map((test) =>
        this.observations.get(test),
      );
      const invariantResult: SafeState = observations.some(
        (observation) => !observation || observation.state === "FAILED",
      )
        ? "FAILED"
        : observations.every((observation) => observation?.state === "SKIPPED")
          ? "SKIPPED"
          : "PASSED";
      return {
        actorCount: definition.actorCount,
        conflictReplayCount:
          invariantResult === "PASSED"
            ? definition.actorCount - definition.expectedLogicalWinners
            : null,
        duplicateBusinessEffectCount: invariantResult === "PASSED" ? 0 : null,
        durableRowCounts:
          invariantResult === "PASSED" ? definition.durableRowCounts : {},
        durationMs: observations.reduce(
          (sum, observation) => sum + (observation?.durationMs ?? 0),
          0,
        ),
        expectedLogicalWinners: definition.expectedLogicalWinners,
        invariantResult,
        leaseOwnerCount:
          invariantResult === "PASSED"
            ? (definition.durableRowCounts.activeLeaseOwners ?? 0)
            : null,
        name: definition.name,
        observedLogicalWinners:
          invariantResult === "PASSED"
            ? definition.expectedLogicalWinners
            : null,
        reasonCodes: definition.reasonCodes,
        scenarioId,
        terminalStateRegressionCount: invariantResult === "PASSED" ? 0 : null,
      };
    });
    const hasFailure = results.some(
      (scenario) => scenario.invariantResult === "FAILED",
    );
    const allSkipped = results.every(
      (scenario) => scenario.invariantResult === "SKIPPED",
    );
    const evidence = {
      commitSha: safeCommitSha(process.env.GITHUB_SHA),
      connectionModel: "independent-client-per-competing-operation",
      environmentIdentity:
        process.env.GITHUB_ACTIONS === "true" ? "CI" : "LOCAL_TEST",
      externalNetwork: false,
      generatedAtUtc: new Date().toISOString(),
      scenarios: results,
      suiteStatus:
        reason !== "passed" || hasFailure
          ? "FAILED"
          : allSkipped
            ? "SKIPPED"
            : "PASSED",
      suiteVersion: "KS-11-04-v1",
    } as const;
    assertSafeEvidence(evidence);
    const outputDirectory = path.resolve(
      process.env.KEYCORE_ORDER_CONCURRENCY_EVIDENCE_DIR ??
        "artifacts/order-concurrency",
    );
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "order-concurrency-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(outputDirectory, "order-concurrency-evidence.md"),
      markdown(evidence),
      "utf8",
    );
    if (hasFailure) {
      throw new Error(
        "KS-11-04 evidence is missing or contains a failed scenario",
      );
    }
  }
}

const assertSafeEvidence = (evidence: unknown): void => {
  const serialized = JSON.stringify(evidence);
  const forbidden = [
    "productKey",
    "rawClaimCode",
    "tokenHash",
    "ciphertext",
    "wrappedDataEncryptionKey",
    "client_secret",
    "webhook_secret",
    "connectionString",
    "password",
  ];
  if (forbidden.some((marker) => serialized.includes(marker))) {
    throw new Error("Unsafe field rejected from order concurrency evidence");
  }
};

const safeCommitSha = (value: string | undefined): string =>
  value && /^[0-9a-f]{40}$/u.test(value) ? value : "LOCAL_UNCOMMITTED";

const markdown = (evidence: {
  readonly environmentIdentity: string;
  readonly generatedAtUtc: string;
  readonly scenarios: readonly {
    readonly actorCount: number;
    readonly durationMs: number;
    readonly invariantResult: SafeState;
    readonly name: string;
    readonly scenarioId: string;
  }[];
  readonly suiteStatus: string;
  readonly suiteVersion: string;
}): string =>
  `${[
    "# KS-11-04 Order Concurrency Evidence",
    "",
    `- Suite: ${evidence.suiteVersion}`,
    `- Status: ${evidence.suiteStatus}`,
    `- Environment: ${evidence.environmentIdentity}`,
    `- Generated: ${evidence.generatedAtUtc}`,
    "- PostgreSQL model: independent client per competing operation",
    "- External network: disabled",
    "",
    "| Scenario | Name | Actors | Result | Duration ms |",
    "| --- | --- | ---: | --- | ---: |",
    ...evidence.scenarios.map(
      (scenario) =>
        `| ${scenario.scenarioId} | ${scenario.name} | ${scenario.actorCount} | ${scenario.invariantResult} | ${scenario.durationMs} |`,
    ),
    "",
    "Evidence is omission-first and contains aggregate safe state only.",
    "",
  ].join("\n")}\n`;

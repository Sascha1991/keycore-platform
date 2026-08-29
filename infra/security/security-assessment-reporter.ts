import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
} from "vitest/node";

type ScenarioState = "FAILED" | "NOT_APPLICABLE" | "PASSED" | "SKIPPED";

interface SecurityScenarioDefinition {
  readonly applicable: boolean;
  readonly boundary: string;
  readonly name: string;
  readonly reasonCodes: readonly string[];
  readonly tests: readonly string[];
}

export const securityScenarios = new Map<string, SecurityScenarioDefinition>([
  [
    "SEC-001",
    {
      applicable: true,
      boundary: "AUTHENTICATED_CUSTOMER",
      name: "AUTHENTICATION_BOUNDARY",
      reasonCodes: ["AUTHENTICATION_REQUIRED", "SESSION_INVALID"],
      tests: [
        "resolves invalid, expired, idle and revoked tokens with stable invalid semantics",
        "persists hash-only customer sessions and enforces lifecycle operations",
      ],
    },
  ],
  [
    "SEC-002",
    {
      applicable: true,
      boundary: "CUSTOMER_OWNERSHIP",
      name: "AUTHORIZATION_IDOR",
      reasonCodes: ["ORDER_UNAVAILABLE", "KEY_ACCESS_UNAVAILABLE"],
      tests: [
        "fails closed for cross-customer sessions, capability context mismatch and order/fulfillment confusion",
        "uses the same unavailable result for wrong owner and missing orders",
        "fails enumeration-safe for wrong-owner, unknown, unclaimed, and test principals",
        "filters account order reads by customer ownership at SQL boundary",
      ],
    },
  ],
  [
    "SEC-003",
    {
      applicable: true,
      boundary: "GUEST_TO_ACCOUNT_CLAIM",
      name: "GUEST_ORDER_CLAIM",
      reasonCodes: ["CLAIM_DENIED", "CHECKOUT_EMAIL_MISMATCH"],
      tests: [
        "claims only with authenticated verified matching email plus active claim code",
        "persists hash-only claim credentials, reissues safely and consumes once under concurrency",
        "keeps legacy null-email orders unclaimable, enforces immutable snapshots and token hash uniqueness",
      ],
    },
  ],
  [
    "SEC-004",
    {
      applicable: true,
      boundary: "PRODUCT_KEY_CONFIDENTIALITY",
      name: "PRODUCT_KEY_CANARY",
      reasonCodes: ["CANARY_LEAK_COUNT_ZERO"],
      tests: [
        "assesses runtime canary omission across logs, audit and evidence-safe surfaces",
        "E2E-015 LEAKAGE_CANARY",
        "stores encrypted secret transactionally and leaves no plaintext columns",
        "does not copy customer assertions or synthetic secrets into claim, events, audit, or payload",
      ],
    },
  ],
  [
    "SEC-005",
    {
      applicable: true,
      boundary: "SECRET_TOKEN_HANDLING",
      name: "SECRET_TOKEN_LEAKAGE",
      reasonCodes: ["SENSITIVE_VALUE_OMITTED"],
      tests: [
        "detects expanded synthetic credential classes without exposing values",
        "does not expose raw session credentials in limiter keys, responses or audit",
        "does not leak synthetic key, session or capability material through denied and failure observations",
      ],
    },
  ],
  [
    "SEC-006",
    {
      applicable: true,
      boundary: "LOGGING_AUDIT",
      name: "LOGGING_AUDIT_SAFETY",
      reasonCodes: ["AUDIT_METADATA_REJECTED"],
      tests: [
        "rejects secret canary field names at any depth before persistence",
        "rejects secret-shaped values hidden under otherwise safe field names",
        "omits nested sensitive data and rejects secret-shaped values in allowed fields",
        "rejects unsafe audit metadata before persistence",
      ],
    },
  ],
  [
    "SEC-007",
    {
      applicable: true,
      boundary: "PAYMENT_PROVIDER",
      name: "PAYMENT_WEBHOOK_TRUST",
      reasonCodes: ["INVALID_SIGNATURE", "PAYMENT_EVENT_CONFLICT"],
      tests: [
        "rejects modified payloads, missing signatures and unsupported event types",
        "rejects invalid webhook signatures before receipt or order mutation",
        "persists provider creation, rejects external ID reuse and prevents captured regression",
        "enforces payment amount, status, provider and immutable commercial constraints",
      ],
    },
  ],
  [
    "SEC-008",
    {
      applicable: true,
      boundary: "PROCUREMENT_SUPPLIER",
      name: "PROCUREMENT_AUTHORIZATION_AMBIGUITY",
      reasonCodes: ["PAYMENT_NOT_CAPTURED", "RECONCILIATION_REQUIRED"],
      tests: [
        "fails closed unless payment is captured and risk is approved",
        "blocks ambiguous operation fallback and successful duplicate procurement",
        "allows one active execution owner and treats stale post-dispatch as ambiguous",
      ],
    },
  ],
  [
    "SEC-009",
    {
      applicable: true,
      boundary: "FULFILLMENT_VAULT",
      name: "FULFILLMENT_KEY_RETRIEVAL",
      reasonCodes: ["FULFILLMENT_NOT_APPROVED", "OWNERSHIP_LOST"],
      tests: [
        "blocks unconfirmed procurement, missing supplier order and unsupported suppliers",
        "requires current retrieval ownership and prevents orphan secrets",
        "keeps terminal retrieved state from stale overwrite",
      ],
    },
  ],
  [
    "SEC-010",
    {
      applicable: true,
      boundary: "CUSTOMER_DELIVERY_TRANSPORT",
      name: "CUSTOMER_KEY_DELIVERY",
      reasonCodes: ["ORIGIN_DENIED", "CSRF_DENIED", "RATE_LIMITED"],
      tests: [
        "denies key access origin, csrf, limiter and authority-field failures before decrypt",
        "denies bad authentication, object authorization, csrf, origin and capability before decrypt or delivery",
        "defines strict transport policy for session cookies, origin and csrf",
        "persists secure customer delivery state and concurrency invariants",
      ],
    },
  ],
  [
    "SEC-011",
    {
      applicable: true,
      boundary: "REGISTRATION_VERIFICATION",
      name: "REGISTRATION_VERIFICATION",
      reasonCodes: ["VERIFICATION_DENIED", "TOKEN_CONSUMED"],
      tests: [
        "issues hash-only one-time verification challenges and verifies through trusted authority",
        "collapses invalid, expired, consumed and concurrent verification failures",
        "persists hash-only challenges, reissues deterministically and consumes once under concurrency",
      ],
    },
  ],
  [
    "SEC-012",
    {
      applicable: true,
      boundary: "FRAUD_RISK",
      name: "FRAUD_RISK_BYPASS",
      reasonCodes: ["RISK_NOT_APPROVED", "VELOCITY_SIGNAL_UNAVAILABLE"],
      tests: [
        "does not let stale review approval authorize changed facts",
        "fails closed when checkout-email velocity requires an unavailable correlation secret",
        "enforces safe persistence constraints",
        "fails closed without a velocity correlation secret and avoids partial event persistence",
      ],
    },
  ],
  [
    "SEC-013",
    {
      applicable: true,
      boundary: "REFUND_SUPPORT",
      name: "REFUND_SUPPORT_BOUNDARY",
      reasonCodes: ["OPTIMISTIC_CONCURRENCY_CONFLICT", "SUPPORT_UNAVAILABLE"],
      tests: [
        "keeps customer-visible messages separate from internal operator notes",
        "links dispute, fraud, and fulfillment references only when the order matches exactly",
        "allows one concurrent refund request and keeps commercial fields immutable",
        "persists customer-owned cases with SQL-scoped listing and internal-note hiding",
      ],
    },
  ],
  [
    "SEC-014",
    {
      applicable: true,
      boundary: "SUPPLIER_CLAIM",
      name: "SUPPLIER_CLAIM_BOUNDARY",
      reasonCodes: ["SUPPLIER_CLAIM_DENIED", "CLAIM_IDENTITY_MISMATCH"],
      tests: [
        "fails closed for default authority and rejects request supplier authority",
        "requires proven procurement and exact fulfillment for key-related claims",
        "enforces exact-order references, derived supplier identity, and immutable claim identity",
        "links finalized exact-order evidence atomically and keeps history append-only",
      ],
    },
  ],
  [
    "SEC-015",
    {
      applicable: true,
      boundary: "POSTGRESQL_INVARIANTS",
      name: "DATABASE_DIRECT_WRITE_RESISTANCE",
      reasonCodes: ["DATABASE_CONSTRAINT_REJECTED"],
      tests: [
        "has no plaintext-key columns in encrypted key records",
        "rejects duplicate encrypted key records for the same order line",
        "rejects invalid database session invariants",
        "enforces message, event, and ownership persistence constraints",
      ],
    },
  ],
  [
    "SEC-016",
    {
      applicable: true,
      boundary: "OPERATIONS_AUTHORITY",
      name: "EMERGENCY_CONTROLS",
      reasonCodes: [
        "OPERATIONS_CONTROL_PAUSED",
        "OPERATIONS_CONTROL_UNAVAILABLE",
      ],
      tests: [
        "applies a durable global pause to high-risk mutations without granting authority",
        "persists a global pause and denies checkout without consulting Redis",
      ],
    },
  ],
  [
    "SEC-017",
    {
      applicable: true,
      boundary: "GERMANY_ELIGIBILITY",
      name: "GERMANY_ELIGIBILITY_BYPASS",
      reasonCodes: ["REGION_EVIDENCE_MISSING", "VPN_ACTIVATION_BLOCKED"],
      tests: [
        "fails closed when a supplier region has no registered semantics",
        "unpublishes without hard delete when Germany eligibility is lost",
        "blocked supplier offer does not block an allowed supplier offer",
      ],
    },
  ],
  [
    "SEC-018",
    {
      applicable: true,
      boundary: "SUPPLY_CHAIN",
      name: "DEPENDENCY_SUPPLY_CHAIN",
      reasonCodes: [
        "LOCKFILE_INTEGRITY_VERIFIED",
        "MUTABLE_ACTION_REFS_RECORDED",
      ],
      tests: [
        "reviews lockfile lifecycle scripts and workflow dependency posture",
      ],
    },
  ],
  [
    "SEC-019",
    {
      applicable: true,
      boundary: "REPOSITORY_SECRET_SCAN",
      name: "STATIC_SECRET_SCAN",
      reasonCodes: ["SECRET_SCAN_CLEAN"],
      tests: [
        "detects expanded synthetic credential classes without exposing values",
      ],
    },
  ],
  [
    "SEC-020",
    {
      applicable: false,
      boundary: "PRODUCTION_HTTP_EDGE",
      name: "BROWSER_RESPONSE_HEADERS",
      reasonCodes: ["NOT_APPLICABLE_CURRENT_ARCHITECTURE"],
      tests: [
        "classifies production browser response headers as not applicable to the current edge",
      ],
    },
  ],
]);

export const securityTestNamePattern = new RegExp(
  [...securityScenarios.values()]
    .flatMap((scenario) => scenario.tests)
    .map(escapeRegExp)
    .join("|"),
  "u",
);

interface Observation {
  readonly durationMs: number;
  readonly state: "FAILED" | "PASSED" | "SKIPPED";
}

const findings = [
  {
    affectedComponent: "audit metadata validation and repository secret scan",
    attackPrecondition:
      "A trusted producer or contributor places sensitive material under a non-sensitive-looking field or an uncovered credential format",
    businessImpact:
      "Sensitive material could become durable or committed and visible to operators or CI readers",
    evidence: ["SEC-005", "SEC-006", "SEC-019"],
    exploitNarrative:
      "The previous checks emphasized forbidden field names and a smaller credential pattern set, allowing selected secret-shaped values to evade the central guard",
    findingId: "FIND-001",
    remediation:
      "Reject secret-shaped audit string values and expand shared static credential patterns with regression coverage",
    remediationStatus: "REMEDIATED",
    residualRisk:
      "Pattern detection is defense in depth; omission-first typed producers and external secret management remain required",
    severity: "MEDIUM",
  },
  {
    affectedComponent: "GitHub Actions workflow dependencies",
    attackPrecondition:
      "Compromise or malicious retargeting of an upstream mutable major-version action tag",
    businessImpact:
      "CI code execution could access repository contents and synthetic CI service credentials",
    evidence: ["SEC-018"],
    exploitNarrative:
      "Workflow actions use reviewed major tags rather than immutable commit SHAs",
    findingId: "FIND-002",
    owner: "ENGINEERING_SECURITY",
    remediation:
      "Pin action dependencies to reviewed immutable commit SHAs and establish an update cadence",
    remediationStatus: "OPEN_DEFERRED_TO_PHASE_12",
    remediationTarget: "PHASE_12_DEPLOYMENT_HARDENING",
    residualRisk:
      "Workflow permissions remain contents-read and no production credentials are present in this phase",
    severity: "LOW",
  },
] as const;

const residualRisks = [
  risk(
    "RR-001",
    "Production HTTP edge and browser headers",
    "DEFERRED_TO_PHASE_12",
    "SECURITY",
    "No concrete production HTTP edge is owned by this repository",
  ),
  risk(
    "RR-002",
    "Production key-management integration",
    "DEFERRED_TO_PHASE_12",
    "SECURITY",
    "Current providers are development/test boundaries",
  ),
  risk(
    "RR-003",
    "Production observability exporters",
    "DEFERRED_TO_PHASE_12",
    "OPERATIONS",
    "Repository owns safe schemas but no production exporter deployment",
  ),
  risk(
    "RR-004",
    "Production Stripe endpoint and configuration",
    "DEFERRED_TO_PHASE_12",
    "FINANCE_ENGINEERING",
    "Only synthetic/test payment boundaries were assessed",
  ),
  risk(
    "RR-005",
    "Production supplier credentials and network behavior",
    "DEFERRED_TO_PHASE_12",
    "OPERATIONS_SECURITY",
    "No supplier network or credential was used",
  ),
  risk(
    "RR-006",
    "WooCommerce production transport",
    "DEFERRED_TO_PHASE_12",
    "ENGINEERING",
    "Current adapter and transport policy are not a deployed edge",
  ),
  risk(
    "RR-007",
    "Infrastructure WAF and edge rate limiting",
    "DEFERRED_TO_PHASE_12",
    "SECURITY_OPERATIONS",
    "Infrastructure is outside the current repository boundary",
  ),
  risk(
    "RR-008",
    "Recovery and outage exercise",
    "DEFERRED_TO_KS-11-06",
    "OPERATIONS",
    "Recovery evidence is a separate binding checkpoint",
  ),
  risk(
    "RR-009",
    "Customer and operator UX acceptance",
    "DEFERRED_TO_KS-11-07",
    "PROJECT_OWNER",
    "Human UAT cannot be inferred from automated security tests",
  ),
  risk(
    "RR-010",
    "Mutable CI action references",
    "DEFERRED_TO_PHASE_12",
    "ENGINEERING_SECURITY",
    "Minimal permissions mitigate but do not eliminate upstream tag risk",
  ),
  risk(
    "RR-011",
    "Synthetic-only assessment execution",
    "ACCEPTED_FOR_CURRENT_PHASE",
    "SECURITY",
    "Phase 11 prohibits production data, credentials and mutations",
  ),
] as const;

export class SecurityAssessmentReporter implements Reporter {
  private readonly observations = new Map<string, Observation>();

  public onTestCaseResult(testCase: TestCase): void {
    if (
      ![...securityScenarios.values()].some((scenario) =>
        scenario.tests.includes(testCase.name),
      )
    )
      return;
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
    const scenarios = [...securityScenarios].map(([scenarioId, definition]) => {
      const observations = definition.tests.map((test) =>
        this.observations.get(test),
      );
      const state: ScenarioState = observations.some(
        (observation) => !observation || observation.state === "FAILED",
      )
        ? "FAILED"
        : observations.some((observation) => observation?.state === "SKIPPED")
          ? "SKIPPED"
          : definition.applicable
            ? "PASSED"
            : "NOT_APPLICABLE";
      return {
        applicable: definition.applicable,
        boundary: definition.boundary,
        durationMs: observations.reduce(
          (sum, observation) => sum + (observation?.durationMs ?? 0),
          0,
        ),
        name: definition.name,
        reasonCodes: definition.reasonCodes,
        scenarioId,
        status: state,
      };
    });
    const blockingFindings = findings.filter(
      (finding) =>
        ["CRITICAL", "HIGH"].includes(finding.severity) &&
        finding.remediationStatus !== "REMEDIATED",
    );
    const requiredFailure = scenarios.some(
      (scenario) =>
        scenario.status === "FAILED" ||
        (process.env.GITHUB_ACTIONS === "true" &&
          scenario.applicable &&
          scenario.status === "SKIPPED"),
    );
    const suiteStatus =
      reason !== "passed" || requiredFailure || blockingFindings.length > 0
        ? "FAILED"
        : scenarios.some((scenario) => scenario.status === "SKIPPED")
          ? "SKIPPED"
          : "PASSED";
    const evidence = {
      canaryLeakage: {
        credentialCanaryLeaks: suiteStatus === "PASSED" ? 0 : null,
        evidenceContainsRawCanaries: false,
        productKeyCanaryLeaks: suiteStatus === "PASSED" ? 0 : null,
        scannedSurfaces: [
          "application-log-records",
          "audit-metadata",
          "outbox-and-queue-projections",
          "customer-safe-errors",
          "support-dispute-and-claim-projections",
          "generated-security-evidence",
        ],
        tokenCanaryLeaks: suiteStatus === "PASSED" ? 0 : null,
        unauthorizedDeliveryLeaks: suiteStatus === "PASSED" ? 0 : null,
      },
      commitSha: safeCommitSha(process.env.GITHUB_SHA),
      environmentIdentity:
        process.env.GITHUB_ACTIONS === "true" ? "CI" : "LOCAL_TEST",
      externalNetwork: false,
      findingSummary: findingSummary(),
      generatedAtUtc: new Date().toISOString(),
      postgres: "ISOLATED_EPHEMERAL",
      redis: "NOT_REQUIRED_AS_AUTHORITY",
      scenarios,
      suiteStatus,
      suiteVersion: "KS-11-05-v1",
    } as const;
    assertSafeEvidence(evidence);
    const outputDirectory = path.resolve(
      process.env.KEYCORE_SECURITY_ASSESSMENT_EVIDENCE_DIR ??
        "artifacts/security-assessment",
    );
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeJson(outputDirectory, "security-assessment-evidence.json", evidence),
      writeFile(
        path.join(outputDirectory, "security-assessment-evidence.md"),
        markdown(evidence),
        "utf8",
      ),
      writeJson(outputDirectory, "security-findings.json", {
        blockingFindingCount: blockingFindings.length,
        findings,
        summary: findingSummary(),
      }),
      writeJson(outputDirectory, "residual-risk-register.json", {
        residualRisks,
      }),
    ]);
    if (requiredFailure || blockingFindings.length > 0) {
      throw new Error(
        "KS-11-05 has a failed/skipped required scenario or blocking finding",
      );
    }
  }
}

function risk(
  riskId: string,
  title: string,
  classification: string,
  owner: string,
  rationale: string,
) {
  return { classification, owner, rationale, riskId, title };
}

const findingSummary = () =>
  Object.fromEntries(
    ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((severity) => [
      severity,
      findings.filter((finding) => finding.severity === severity).length,
    ]),
  );

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const safeCommitSha = (value: string | undefined): string =>
  value && /^[0-9a-f]{40}$/u.test(value) ? value : "LOCAL_UNCOMMITTED";

const writeJson = async (
  directory: string,
  filename: string,
  value: unknown,
): Promise<void> => {
  await writeFile(
    path.join(directory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

const assertSafeEvidence = (evidence: unknown): void => {
  const serialized = JSON.stringify(evidence);
  const forbiddenPatterns = [
    /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/u,
    /\bwhsec_[A-Za-z0-9]{12,}\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/iu,
    /\bTEST(?:-[A-Z0-9]{5}){3,4}\b/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(serialized))) {
    throw new Error("Raw sensitive canary rejected from security evidence");
  }
};

const markdown = (evidence: {
  readonly findingSummary: Readonly<Record<string, number>>;
  readonly generatedAtUtc: string;
  readonly scenarios: readonly {
    readonly boundary: string;
    readonly durationMs: number;
    readonly scenarioId: string;
    readonly status: ScenarioState;
  }[];
  readonly suiteStatus: string;
  readonly suiteVersion: string;
}): string =>
  `${[
    "# KS-11-05 Security Assessment Evidence",
    "",
    `- Suite: ${evidence.suiteVersion}`,
    `- Status: ${evidence.suiteStatus}`,
    `- Generated: ${evidence.generatedAtUtc}`,
    `- Critical findings: ${evidence.findingSummary.CRITICAL ?? 0}`,
    `- High findings: ${evidence.findingSummary.HIGH ?? 0}`,
    "- External network: disabled",
    "",
    "| Scenario | Boundary | Status | Duration ms |",
    "| --- | --- | --- | ---: |",
    ...evidence.scenarios.map(
      (scenario) =>
        `| ${scenario.scenarioId} | ${scenario.boundary} | ${scenario.status} | ${scenario.durationMs} |`,
    ),
    "",
    "Evidence is omission-first and contains no raw canary or credential values.",
    "",
  ].join("\n")}\n`;

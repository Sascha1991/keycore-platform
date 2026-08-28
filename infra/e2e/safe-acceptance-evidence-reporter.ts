import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
} from "vitest/node";

const scenarioNames = new Map<string, string>([
  ["E2E-001", "ACCOUNT_PURCHASE_SUCCESS"],
  ["E2E-002", "GUEST_PURCHASE_ACCOUNT_CLAIM"],
  ["E2E-003", "DELAYED_FULFILLMENT"],
  ["E2E-004", "SUPPLIER_FAILURE"],
  ["E2E-005", "SUPPLIER_AMBIGUOUS"],
  ["E2E-006", "PAYMENT_FAILURE"],
  ["E2E-007", "FRAUD_REVIEW"],
  ["E2E-008", "FRAUD_DENY"],
  ["E2E-009", "REFUND"],
  ["E2E-010", "SUPPORT"],
  ["E2E-011", "REPLAY_IDEMPOTENCY"],
  ["E2E-012", "EMERGENCY_CONTROLS"],
  ["E2E-013", "EMAIL_SAFETY"],
  ["E2E-014", "INVOICE_ACCESS"],
  ["E2E-015", "LEAKAGE_CANARY"],
  ["E2E-PG-001", "POSTGRESQL_JOURNEY_COHERENCE"],
] as const);

interface SafeScenarioEvidence {
  readonly durationMs: number;
  readonly finalState: "FAILED" | "PASSED" | "SKIPPED";
  readonly scenarioId: string;
  readonly scenarioName: string;
}

export class SafeAcceptanceEvidenceReporter implements Reporter {
  private readonly scenarios = new Map<string, SafeScenarioEvidence>();

  public onTestCaseResult(testCase: TestCase): void {
    const scenarioId = scenarioIdFromName(testCase.name);
    if (!scenarioId) return;
    const scenarioName = scenarioNames.get(scenarioId);
    if (!scenarioName) {
      throw new Error("Unregistered E2E acceptance scenario");
    }
    const result = testCase.result();
    this.scenarios.set(scenarioId, {
      durationMs: Math.max(0, Math.round(testCase.diagnostic()?.duration ?? 0)),
      finalState:
        result.state === "passed"
          ? "PASSED"
          : result.state === "skipped"
            ? "SKIPPED"
            : "FAILED",
      scenarioId,
      scenarioName,
    });
  }

  public async onTestRunEnd(
    _testModules: readonly TestModule[],
    _unhandledErrors: readonly unknown[],
    reason: TestRunEndReason,
  ): Promise<void> {
    const outputDirectory = path.resolve(
      process.env.KEYCORE_E2E_EVIDENCE_DIR ?? "artifacts/e2e-acceptance",
    );
    const scenarios = [...this.scenarios.values()].sort((left, right) =>
      left.scenarioId.localeCompare(right.scenarioId),
    );
    const evidence = {
      adapters: {
        encryption: "synthetic-development-key-management",
        mail: "captured-test-transport",
        payment: "deterministic-synthetic",
        supplier: "supplier-neutral-synthetic-outcomes",
      },
      commitSha: safeCommitSha(process.env.GITHUB_SHA),
      environmentIdentity:
        process.env.GITHUB_ACTIONS === "true" ? "CI" : "LOCAL_TEST",
      generatedAtUtc: new Date().toISOString(),
      scenarioCount: scenarios.length,
      scenarios,
      suiteStatus: reason === "passed" ? "PASSED" : "FAILED",
      suiteVersion: "KS-11-02-v1",
    } as const;
    assertEvidenceIsSafe(evidence);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "acceptance-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(outputDirectory, "acceptance-summary.md"),
      markdownSummary(evidence),
      "utf8",
    );
  }
}

const scenarioIdFromName = (name: string): string | null =>
  /^(E2E-(?:\d{3}|PG-\d{3}))\b/u.exec(name)?.[1] ?? null;

const safeCommitSha = (value: string | undefined): string =>
  value && /^[0-9a-f]{40}$/u.test(value) ? value : "LOCAL_UNCOMMITTED";

const assertEvidenceIsSafe = (evidence: unknown): void => {
  const serialized = JSON.stringify(evidence);
  const forbidden = [
    "KEYRANO_E2E_SYNTHETIC_SECRET_CANARY",
    "KEYRANO_E2E_SYNTHETIC_CLAIM",
    "client_secret",
    "webhook_secret",
    "rawClaimCode",
    "tokenHash",
    "ciphertext",
    "wrappedDataEncryptionKey",
  ];
  if (forbidden.some((marker) => serialized.includes(marker))) {
    throw new Error("Unsafe field or value rejected from E2E evidence");
  }
};

const markdownSummary = (evidence: {
  readonly commitSha: string;
  readonly environmentIdentity: string;
  readonly generatedAtUtc: string;
  readonly scenarios: readonly SafeScenarioEvidence[];
  readonly suiteStatus: string;
  readonly suiteVersion: string;
}): string => {
  const rows = evidence.scenarios.map(
    (scenario) =>
      `| ${scenario.scenarioId} | ${scenario.scenarioName} | ${scenario.finalState} | ${scenario.durationMs} |`,
  );
  return `${[
    "# KS-11-02 Acceptance Evidence",
    "",
    `- Suite: ${evidence.suiteVersion}`,
    `- Status: ${evidence.suiteStatus}`,
    `- Environment: ${evidence.environmentIdentity}`,
    `- Commit: ${evidence.commitSha}`,
    `- Generated: ${evidence.generatedAtUtc}`,
    "",
    "| Scenario | Name | Result | Duration ms |",
    "| --- | --- | --- | ---: |",
    ...rows,
    "",
    "Evidence is omission-first and contains synthetic identifiers and safe state metadata only.",
    "",
  ].join("\n")}`;
};

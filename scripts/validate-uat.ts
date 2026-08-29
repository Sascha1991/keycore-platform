import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { scanSecretText } from "./secret-patterns.mjs";

const SCENARIO_IDS = Array.from(
  { length: 18 },
  (_, index) => `UAT-${String(index + 1).padStart(3, "0")}`,
);
const SCENARIO_ID_SET = new Set(SCENARIO_IDS);
const RESULT_STATUSES = new Set([
  "PENDING",
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY",
]);
const UI_STATUSES = new Set([
  "EXECUTABLE_NOW",
  "PARTIALLY_EXECUTABLE",
  "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY",
]);
const APPROVAL_STATUSES = new Set(["NOT_APPROVED", "APPROVED", "REJECTED"]);
const REQUIRED_SCENARIO_FIELDS = [
  "id",
  "title",
  "objective",
  "role",
  "prerequisites",
  "testData",
  "humanSteps",
  "expectedResult",
  "validatedRule",
  "automatedEvidence",
  "uiReadiness",
  "humanActionRequired",
  "approvalRequirement",
] as const;
const REQUIRED_RESULT_FIELDS = [
  "scenario",
  "status",
  "reviewer",
  "reviewedAt",
  "evidence",
  "notes",
] as const;
const FORBIDDEN_DATA_KEYS = new Set([
  "apikey",
  "credential",
  "deliverycapability",
  "password",
  "productkey",
  "secret",
  "sessiontoken",
  "token",
]);
const SAFE_REFERENCE = /^(?:docs|artifacts)\/[A-Za-z0-9._/-]+$/u;
const SAFE_IDENTIFIER = /^(?:EVIDENCE|UAT)-[A-Z0-9-]+$/u;

type JsonRecord = Record<string, unknown>;

interface UatPackage {
  approval: JsonRecord;
  readiness: JsonRecord;
  residualRisks: JsonRecord;
  results: JsonRecord;
  supportingEvidence: JsonRecord;
  texts: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(
  value: unknown,
  label: string,
  issues: string[],
): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    issues.push(`${label} must be an array of objects`);
    return [];
  }
  return value;
}

function hasNonEmptyString(record: JsonRecord, field: string): boolean {
  return typeof record[field] === "string" && record[field].trim().length > 0;
}

function hasNonEmptyStringArray(record: JsonRecord, field: string): boolean {
  const value = record[field];
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function findForbiddenDataKeys(value: unknown, location = "root"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findForbiddenDataKeys(item, `${location}[${String(index)}]`),
    );
  }
  if (!isRecord(value)) {
    return [];
  }

  const findings: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^A-Za-z]/gu, "").toLowerCase();
    if (FORBIDDEN_DATA_KEYS.has(normalized)) {
      findings.push(`${location}.${key}`);
    }
    findings.push(...findForbiddenDataKeys(nested, `${location}.${key}`));
  }
  return findings;
}

async function readJson(
  root: string,
  name: string,
): Promise<[JsonRecord, string]> {
  const filePath = path.join(root, "artifacts", "user-acceptance", name);
  const text = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return [parsed, text];
}

async function loadPackage(root: string): Promise<UatPackage> {
  const [approval, readiness, residualRisks, results, supportingEvidence] =
    await Promise.all([
      readJson(root, "human-approval.json"),
      readJson(root, "uat-readiness.json"),
      readJson(root, "uat-residual-risks.json"),
      readJson(root, "uat-results.json"),
      readJson(root, "uat-supporting-evidence.json"),
    ]);

  return {
    approval: approval[0],
    readiness: readiness[0],
    residualRisks: residualRisks[0],
    results: results[0],
    supportingEvidence: supportingEvidence[0],
    texts: [
      approval[1],
      readiness[1],
      residualRisks[1],
      results[1],
      supportingEvidence[1],
    ],
  };
}

function validateScenarios(readiness: JsonRecord, issues: string[]): void {
  const scenarios = records(readiness.scenarios, "readiness.scenarios", issues);
  const ids = scenarios.map((scenario) => scenario.id);

  if (ids.length !== SCENARIO_IDS.length || new Set(ids).size !== ids.length) {
    issues.push("UAT scenario IDs must occur exactly once");
  }
  if (ids.some((id) => typeof id !== "string" || !SCENARIO_ID_SET.has(id))) {
    issues.push("UAT scenario IDs contain a missing or unknown ID");
  }
  if (SCENARIO_IDS.some((id) => !ids.includes(id))) {
    issues.push("UAT-001 through UAT-018 must all be present");
  }

  for (const scenario of scenarios) {
    const id =
      typeof scenario.id === "string" ? scenario.id : "unknown scenario";
    for (const field of REQUIRED_SCENARIO_FIELDS) {
      if (!(field in scenario)) {
        issues.push(`${id} is missing ${field}`);
      }
    }
    for (const field of [
      "id",
      "title",
      "objective",
      "role",
      "expectedResult",
      "validatedRule",
      "uiReadiness",
      "humanActionRequired",
      "approvalRequirement",
    ]) {
      if (!hasNonEmptyString(scenario, field)) {
        issues.push(`${id}.${field} must be a non-empty string`);
      }
    }
    for (const field of [
      "prerequisites",
      "testData",
      "humanSteps",
      "automatedEvidence",
    ]) {
      if (!hasNonEmptyStringArray(scenario, field)) {
        issues.push(`${id}.${field} must be a non-empty string array`);
      }
    }
    if (!UI_STATUSES.has(String(scenario.uiReadiness))) {
      issues.push(`${id} has invalid UI readiness`);
    }
    if (
      scenario.uiReadiness !== "EXECUTABLE_NOW" &&
      (!hasNonEmptyString(scenario, "reason") ||
        !hasNonEmptyString(scenario, "targetDependency"))
    ) {
      issues.push(`${id} requires a reason and target dependency`);
    }
    const evidence = Array.isArray(scenario.automatedEvidence)
      ? scenario.automatedEvidence
      : [];
    if (
      evidence.some(
        (reference) =>
          typeof reference !== "string" || !SAFE_IDENTIFIER.test(reference),
      )
    ) {
      issues.push(`${id} contains a malformed automated evidence identifier`);
    }
  }
}

function validateResults(resultsDocument: JsonRecord, issues: string[]): void {
  const results = records(resultsDocument.results, "results.results", issues);
  const ids = results.map((result) => result.scenario);
  if (
    ids.length !== SCENARIO_IDS.length ||
    new Set(ids).size !== ids.length ||
    SCENARIO_IDS.some((id) => !ids.includes(id)) ||
    ids.some((id) => typeof id !== "string" || !SCENARIO_ID_SET.has(id))
  ) {
    issues.push("UAT results must contain each known scenario exactly once");
  }

  for (const result of results) {
    const id =
      typeof result.scenario === "string" ? result.scenario : "unknown result";
    for (const field of REQUIRED_RESULT_FIELDS) {
      if (!(field in result)) {
        issues.push(`${id} result is missing ${field}`);
      }
    }
    const status = String(result.status);
    if (!RESULT_STATUSES.has(status)) {
      issues.push(`${id} has invalid result status`);
    }
    if (
      status === "PASS" &&
      (!hasNonEmptyString(result, "reviewer") ||
        !hasNonEmptyString(result, "reviewedAt"))
    ) {
      issues.push(`${id} PASS requires a human reviewer and reviewedAt`);
    }
    if (result.reviewer !== null || result.reviewedAt !== null) {
      issues.push(
        `${id} initial result must not fabricate reviewer or reviewedAt`,
      );
    }
    if (status === "PASS") {
      issues.push(`${id} initial repository result must not be PASS`);
    }
    if (
      (status === "BLOCKED" ||
        status === "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY") &&
      (!hasNonEmptyString(result, "reason") ||
        !hasNonEmptyString(result, "targetDependency"))
    ) {
      issues.push(
        `${id} blocked/non-executable result requires reason and targetDependency`,
      );
    }
    if (!Array.isArray(result.evidence)) {
      issues.push(`${id}.evidence must be an array`);
    }
  }
}

function validateApproval(
  approval: JsonRecord,
  readiness: JsonRecord,
  issues: string[],
): void {
  if (!APPROVAL_STATUSES.has(String(approval.approval))) {
    issues.push("Human approval has an invalid state");
  }
  if (
    approval.scope !== "KS-11-07" ||
    approval.approval !== "NOT_APPROVED" ||
    approval.reviewer !== null ||
    approval.approvedAt !== null
  ) {
    issues.push(
      "Human approval must remain NOT_APPROVED with no reviewer or timestamp",
    );
  }
  if (
    readiness.securityReadiness !== "NOT_APPROVED" ||
    readiness.humanAcceptance !== "PENDING"
  ) {
    issues.push(
      "Security readiness must be NOT_APPROVED and human acceptance PENDING",
    );
  }
}

function validateSupportingEvidence(
  document: JsonRecord,
  issues: string[],
): void {
  if (document.automatedEvidenceIsHumanAcceptance !== false) {
    issues.push(
      "Automated evidence must never be represented as human acceptance",
    );
  }
  const sources = records(
    document.sources,
    "supportingEvidence.sources",
    issues,
  );
  for (const source of sources) {
    if (
      !hasNonEmptyString(source, "id") ||
      !SAFE_IDENTIFIER.test(String(source.id))
    ) {
      issues.push("Supporting evidence has a malformed ID");
    }
    if (
      !hasNonEmptyString(source, "path") ||
      !SAFE_REFERENCE.test(String(source.path))
    ) {
      issues.push("Supporting evidence has an unsafe path");
    }
    const supports = source.supports;
    if (
      !Array.isArray(supports) ||
      supports.length === 0 ||
      supports.some((id) => typeof id !== "string" || !SCENARIO_ID_SET.has(id))
    ) {
      issues.push(`${String(source.id)} has malformed scenario references`);
    }
  }
}

function validateResidualRisks(document: JsonRecord, issues: string[]): void {
  const classifications = new Set([
    "BLOCKING_UAT",
    "ACCEPTED_FOR_CURRENT_PHASE",
    "DEFERRED_TO_PHASE_12",
  ]);
  const risks = records(document.risks, "residualRisks.risks", issues);
  for (const risk of risks) {
    const id = String(risk.id);
    if (!/^UAT-RISK-\d{3}$/u.test(id)) {
      issues.push("Residual risk has a malformed ID");
    }
    if (!classifications.has(String(risk.classification))) {
      issues.push(`${id} has an invalid classification`);
    }
    for (const field of ["missingBoundary", "target", "releaseImpact"]) {
      if (!hasNonEmptyString(risk, field)) {
        issues.push(`${id}.${field} must be a non-empty string`);
      }
    }
    const scenarios = risk.scenarios;
    if (
      !Array.isArray(scenarios) ||
      scenarios.length === 0 ||
      scenarios.some(
        (scenario) =>
          typeof scenario !== "string" || !SCENARIO_ID_SET.has(scenario),
      )
    ) {
      issues.push(`${id} has malformed scenario references`);
    }
  }
}

export async function validateUatPackage(
  root = process.cwd(),
): Promise<string[]> {
  const packageData = await loadPackage(root);
  const issues: string[] = [];

  validateScenarios(packageData.readiness, issues);
  validateResults(packageData.results, issues);
  validateApproval(packageData.approval, packageData.readiness, issues);
  validateSupportingEvidence(packageData.supportingEvidence, issues);
  validateResidualRisks(packageData.residualRisks, issues);

  const secretFindings = packageData.texts.flatMap((text) =>
    scanSecretText(text),
  );
  if (secretFindings.length > 0) {
    issues.push(
      `UAT artifacts contain secret-shaped material: ${[...new Set(secretFindings)].join(", ")}`,
    );
  }
  const forbiddenKeys = [
    packageData.approval,
    packageData.readiness,
    packageData.residualRisks,
    packageData.results,
    packageData.supportingEvidence,
  ].flatMap((value) => findForbiddenDataKeys(value));
  if (forbiddenKeys.length > 0) {
    issues.push(
      `UAT artifacts contain forbidden sensitive data fields: ${forbiddenKeys.join(", ")}`,
    );
  }

  return issues;
}

async function main(): Promise<void> {
  const issues = await validateUatPackage();
  if (issues.length > 0) {
    console.error("KS-11-07 UAT package validation failed:");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("KS-11-07 UAT package is structurally valid.");
  console.log("Human acceptance: PENDING; human approval: NOT_APPROVED.");
  console.log(
    "Validated 18 scenarios and 5 omission-first evidence artifacts.",
  );
}

const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}

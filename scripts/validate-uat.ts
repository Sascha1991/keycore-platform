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
const HUMAN_ACCEPTANCE_STATUSES = new Set([
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
]);
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
const RAW_PRODUCT_KEY_REFERENCE =
  /\b(?:TEST-)?[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}(?:-[A-Z0-9]{5})?\b/u;
const ISO_UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/u;

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

function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_UTC_TIMESTAMP.exec(value);
  if (match === null) {
    return false;
  }
  const parts = match.slice(1, 7).map(Number);
  if (parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function isSafeEvidenceReference(reference: string): boolean {
  if (
    RAW_PRODUCT_KEY_REFERENCE.test(reference) ||
    scanSecretText(reference).length > 0
  ) {
    return false;
  }
  if (SAFE_IDENTIFIER.test(reference)) {
    return true;
  }
  if (!SAFE_REFERENCE.test(reference)) {
    return false;
  }
  const segments = reference.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function validateEvidence(
  evidence: unknown,
  label: string,
  required: boolean,
  issues: string[],
): void {
  if (!Array.isArray(evidence)) {
    issues.push(`${label} must be an array`);
    return;
  }
  if (required && evidence.length === 0) {
    issues.push(`${label} must contain safe human evidence`);
  }
  if (
    evidence.some(
      (reference) =>
        typeof reference !== "string" || !isSafeEvidenceReference(reference),
    )
  ) {
    issues.push(`${label} contains an unsafe evidence reference`);
  }
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

function validateScenarios(
  readiness: JsonRecord,
  issues: string[],
): Map<string, JsonRecord> {
  const scenarios = records(readiness.scenarios, "readiness.scenarios", issues);
  const ids = scenarios.map((scenario) => scenario.id);
  const scenariosById = new Map<string, JsonRecord>();

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
    if (SCENARIO_ID_SET.has(id) && !scenariosById.has(id)) {
      scenariosById.set(id, scenario);
    }
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
    if (
      scenario.uiReadiness === "EXECUTABLE_NOW" &&
      (scenario.reason !== undefined || scenario.targetDependency !== undefined)
    ) {
      issues.push(
        `${id} executable readiness must not retain a blocking reason or dependency`,
      );
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
  return scenariosById;
}

function validateResults(
  resultsDocument: JsonRecord,
  scenariosById: Map<string, JsonRecord>,
  issues: string[],
): Map<string, JsonRecord> {
  if (resultsDocument.scope !== "KS-11-07") {
    issues.push("UAT results scope must be KS-11-07");
  }
  const results = records(resultsDocument.results, "results.results", issues);
  const ids = results.map((result) => result.scenario);
  const resultsById = new Map<string, JsonRecord>();
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
    if (SCENARIO_ID_SET.has(id) && !resultsById.has(id)) {
      resultsById.set(id, result);
    }
    for (const field of REQUIRED_RESULT_FIELDS) {
      if (!(field in result)) {
        issues.push(`${id} result is missing ${field}`);
      }
    }
    const status = String(result.status);
    const scenario = scenariosById.get(id);
    const uiReadiness = scenario?.uiReadiness;
    if (!RESULT_STATUSES.has(status)) {
      issues.push(`${id} has invalid result status`);
    }
    const isHumanResult =
      status === "PASS" || status === "FAIL" || status === "BLOCKED";
    if (isHumanResult) {
      if (!hasNonEmptyString(result, "reviewer")) {
        issues.push(`${id} ${status} requires a human reviewer`);
      }
      if (!isValidUtcTimestamp(result.reviewedAt)) {
        issues.push(`${id} ${status} requires a valid ISO-8601 UTC reviewedAt`);
      }
    } else if (result.reviewer !== null || result.reviewedAt !== null) {
      issues.push(`${id} ${status} must not contain reviewer or reviewedAt`);
    }
    validateEvidence(
      result.evidence,
      `${id}.evidence`,
      status === "PASS" || status === "FAIL",
      issues,
    );
    if (status === "PASS") {
      if (uiReadiness !== "EXECUTABLE_NOW") {
        issues.push(`${id} PASS requires EXECUTABLE_NOW UI readiness`);
      }
      if (
        result.reason !== undefined ||
        result.targetDependency !== undefined
      ) {
        issues.push(
          `${id} PASS must not retain a blocking reason or dependency`,
        );
      }
    }
    if (
      (status === "PENDING" || status === "FAIL") &&
      (result.reason !== undefined || result.targetDependency !== undefined)
    ) {
      issues.push(
        `${id} ${status} must not retain a blocking reason or dependency`,
      );
    }
    if (status === "FAIL") {
      if (!hasNonEmptyString(result, "notes")) {
        issues.push(`${id} FAIL requires non-empty notes`);
      }
      if (uiReadiness === "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY") {
        issues.push(`${id} FAIL contradicts non-executable UI readiness`);
      }
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
    if (status === "BLOCKED" && !hasNonEmptyString(result, "notes")) {
      issues.push(`${id} BLOCKED requires non-empty notes`);
    }
    if (
      status === "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY" &&
      uiReadiness !== "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY"
    ) {
      issues.push(
        `${id} non-executable result must match non-executable UI readiness`,
      );
    }
    if (
      uiReadiness === "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY" &&
      status !== "NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY"
    ) {
      issues.push(
        `${id} non-executable UI readiness requires a matching result`,
      );
    }
  }
  return resultsById;
}

function validateApproval(
  approval: JsonRecord,
  readiness: JsonRecord,
  resultsById: Map<string, JsonRecord>,
  issues: string[],
): void {
  const approvalState = String(approval.approval);
  const humanAcceptance = String(readiness.humanAcceptance);
  if (!APPROVAL_STATUSES.has(String(approval.approval))) {
    issues.push("Human approval has an invalid state");
  }
  if (!HUMAN_ACCEPTANCE_STATUSES.has(humanAcceptance)) {
    issues.push("Human acceptance has an invalid state");
  }
  if (!APPROVAL_STATUSES.has(String(readiness.securityReadiness))) {
    issues.push("Security readiness has an invalid independent state");
  }
  if (approval.scope !== "KS-11-07" || readiness.scope !== "KS-11-07") {
    issues.push("UAT readiness and human approval scope must be KS-11-07");
  }
  if (
    approval.notes !== null &&
    (typeof approval.notes !== "string" || approval.notes.trim().length === 0)
  ) {
    issues.push("Human approval notes must be null or a non-empty string");
  }

  const results = [...resultsById.values()];
  const humanResults = results.filter((result) =>
    ["PASS", "FAIL", "BLOCKED"].includes(String(result.status)),
  );
  const allPass =
    results.length === SCENARIO_IDS.length &&
    results.every((result) => result.status === "PASS");
  const uat018Pass = resultsById.get("UAT-018")?.status === "PASS";
  const hasFail = results.some((result) => result.status === "FAIL");

  if (approvalState === "NOT_APPROVED") {
    if (approval.reviewer !== null || approval.approvedAt !== null) {
      issues.push(
        "NOT_APPROVED human approval must not have reviewer or approvedAt",
      );
    }
    if (humanAcceptance !== "PENDING" && humanAcceptance !== "IN_REVIEW") {
      issues.push(
        "NOT_APPROVED human approval requires PENDING or IN_REVIEW acceptance",
      );
    }
  } else {
    if (!hasNonEmptyString(approval, "reviewer")) {
      issues.push(`${approvalState} human approval requires a reviewer`);
    }
    if (!isValidUtcTimestamp(approval.approvedAt)) {
      issues.push(
        `${approvalState} human approval requires a valid ISO-8601 UTC approvedAt`,
      );
    }
  }

  if (humanAcceptance === "PENDING" && humanResults.length > 0) {
    issues.push(
      "PENDING human acceptance must not contain recorded human results",
    );
  }
  if (humanAcceptance === "IN_REVIEW" && humanResults.length === 0) {
    issues.push(
      "IN_REVIEW human acceptance requires at least one recorded human result",
    );
  }
  if (humanAcceptance === "APPROVED") {
    if (approvalState !== "APPROVED") {
      issues.push("APPROVED human acceptance requires APPROVED human approval");
    }
    if (!allPass) {
      issues.push("APPROVED human UAT requires every scenario to PASS");
    }
    if (!uat018Pass) {
      issues.push("APPROVED human UAT requires UAT-018 to PASS");
    }
  }
  if (approvalState === "APPROVED" && humanAcceptance !== "APPROVED") {
    issues.push("APPROVED human approval requires APPROVED human acceptance");
  }
  if (humanAcceptance === "REJECTED") {
    if (approvalState !== "REJECTED" || !hasFail) {
      issues.push(
        "REJECTED human acceptance requires REJECTED approval and a FAIL result",
      );
    }
  }
  if (approvalState === "REJECTED" && humanAcceptance !== "REJECTED") {
    issues.push("REJECTED human approval requires REJECTED human acceptance");
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
      !isSafeEvidenceReference(String(source.path))
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

  const scenariosById = validateScenarios(packageData.readiness, issues);
  const resultsById = validateResults(
    packageData.results,
    scenariosById,
    issues,
  );
  validateApproval(
    packageData.approval,
    packageData.readiness,
    resultsById,
    issues,
  );
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

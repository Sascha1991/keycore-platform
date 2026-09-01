import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateUatPackage } from "../../scripts/validate-uat.js";

const temporaryRoots: string[] = [];
const reviewedAt = "2026-09-15T18:42:13Z";
const reviewer = "KeyRaNo Product Owner";

function recordAt(
  records: Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`Missing test record at index ${String(index)}`);
  }
  return record;
}

function recordById(
  records: Record<string, unknown>[],
  field: string,
  id: string,
): Record<string, unknown> {
  const record = records.find((candidate) => candidate[field] === id);
  if (record === undefined) {
    throw new Error(`Missing test record ${id}`);
  }
  return record;
}

async function packageCopy(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keycore-uat-"));
  temporaryRoots.push(root);
  await cp(
    path.join(process.cwd(), "artifacts", "user-acceptance"),
    path.join(root, "artifacts", "user-acceptance"),
    { recursive: true },
  );
  return root;
}

async function readJson(
  root: string,
  name: string,
): Promise<Record<string, unknown>> {
  const filePath = path.join(root, "artifacts", "user-acceptance", name);
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

async function editJson(
  root: string,
  name: string,
  edit: (document: Record<string, unknown>) => void,
): Promise<void> {
  const filePath = path.join(root, "artifacts", "user-acceptance", name);
  const document = await readJson(root, name);
  edit(document);
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

async function setHumanAcceptance(root: string, state: string): Promise<void> {
  await editJson(root, "uat-readiness.json", (document) => {
    document.humanAcceptance = state;
  });
}

async function setExecutable(root: string, id: string): Promise<void> {
  await editJson(root, "uat-readiness.json", (document) => {
    const scenarios = document.scenarios as Record<string, unknown>[];
    const scenario = recordById(scenarios, "id", id);
    scenario.uiReadiness = "EXECUTABLE_NOW";
    delete scenario.reason;
    delete scenario.targetDependency;
  });
}

async function setHumanResult(
  root: string,
  id: string,
  status: "PASS" | "FAIL" | "BLOCKED",
): Promise<void> {
  await editJson(root, "uat-results.json", (document) => {
    const results = document.results as Record<string, unknown>[];
    const result = recordById(results, "scenario", id);
    result.status = status;
    result.reviewer = reviewer;
    result.reviewedAt = reviewedAt;
    result.notes = `${status} observed by the human reviewer.`;
    result.evidence = [`artifacts/user-acceptance/evidence/${id}-step-1.png`];
    delete result.reason;
    delete result.targetDependency;
  });
}

async function completeHumanUat(root: string): Promise<void> {
  await editJson(root, "uat-readiness.json", (document) => {
    document.humanAcceptance = "APPROVED";
    const scenarios = document.scenarios as Record<string, unknown>[];
    for (const scenario of scenarios) {
      scenario.uiReadiness = "EXECUTABLE_NOW";
      delete scenario.reason;
      delete scenario.targetDependency;
    }
  });
  await editJson(root, "uat-results.json", (document) => {
    const results = document.results as Record<string, unknown>[];
    for (const result of results) {
      const id = String(result.scenario);
      result.status = "PASS";
      result.reviewer = reviewer;
      result.reviewedAt = reviewedAt;
      result.notes = "Expected behavior accepted by the human reviewer.";
      result.evidence = [`artifacts/user-acceptance/evidence/${id}-step-1.png`];
      delete result.reason;
      delete result.targetDependency;
    }
  });
  await editJson(root, "human-approval.json", (document) => {
    document.approval = "APPROVED";
    document.reviewer = reviewer;
    document.approvedAt = reviewedAt;
    document.notes = "All release-applicable UAT scenarios accepted.";
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("KS-11-07 UAT package lifecycle validator", () => {
  it("accepts the current deterministic PREPARATION state", async () => {
    await expect(validateUatPackage()).resolves.toEqual([]);
  });

  it("keeps the checked-in package in scoped review and not approved", async () => {
    const readiness = await readJson(process.cwd(), "uat-readiness.json");
    const approval = await readJson(process.cwd(), "human-approval.json");
    const resultsDocument = await readJson(process.cwd(), "uat-results.json");
    const results = resultsDocument.results as Record<string, unknown>[];

    expect(readiness.humanAcceptance).toBe("IN_REVIEW");
    expect(readiness.securityReadiness).toBe("NOT_APPROVED");
    expect(approval).toMatchObject({
      approval: "NOT_APPROVED",
      approvedAt: null,
      reviewer: null,
    });
    expect(
      results
        .filter((result) => result.status === "PASS")
        .map((result) => result.scenario),
    ).toEqual(["UAT-001", "UAT-002", "UAT-006", "UAT-018"]);
  });

  it("rejects PASS with a null reviewer", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      recordById(results, "scenario", "UAT-001").reviewer = null;
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "PASS requires a human reviewer",
    );
  });

  it("rejects PASS with a null reviewedAt", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      recordById(results, "scenario", "UAT-001").reviewedAt = null;
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "valid ISO-8601 UTC reviewedAt",
    );
  });

  it("rejects PASS while the UI remains non-executable", async () => {
    const root = await packageCopy();
    await setHumanResult(root, "UAT-008", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");

    const issues = (await validateUatPackage(root)).join("\n");
    expect(issues).toContain("PASS requires EXECUTABLE_NOW UI readiness");
    expect(issues).toContain(
      "non-executable UI readiness requires a matching result",
    );
  });

  it("accepts a valid human PASS on an executable scenario", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");

    await expect(validateUatPackage(root)).resolves.toEqual([]);
  });

  it("accepts a structurally valid human FAIL", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "FAIL");
    await setHumanAcceptance(root, "IN_REVIEW");

    await expect(validateUatPackage(root)).resolves.toEqual([]);
  });

  it("rejects BLOCKED without a reason", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "BLOCKED");
    await setHumanAcceptance(root, "IN_REVIEW");

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "blocked/non-executable result requires reason and targetDependency",
    );
  });

  it("rejects malformed human timestamps", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      recordById(results, "scenario", "UAT-001").reviewedAt =
        "2026-02-30T18:42:13Z";
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "valid ISO-8601 UTC reviewedAt",
    );
  });

  it("rejects approval while scenarios remain pending", async () => {
    const root = await packageCopy();
    await setHumanAcceptance(root, "APPROVED");
    await editJson(root, "human-approval.json", (document) => {
      document.approval = "APPROVED";
      document.reviewer = reviewer;
      document.approvedAt = reviewedAt;
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "requires every scenario to PASS",
    );
  });

  it("rejects approval when UAT-018 is not PASS", async () => {
    const root = await packageCopy();
    await completeHumanUat(root);
    await setHumanResult(root, "UAT-018", "BLOCKED");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      const result = recordById(results, "scenario", "UAT-018");
      result.reason = "Final walkthrough cannot proceed.";
      result.targetDependency = "PHASE_12_END_TO_END_STOREFRONT_INTEGRATION";
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "requires UAT-018 to PASS",
    );
  });

  it("rejects approval with a FAIL remaining", async () => {
    const root = await packageCopy();
    await completeHumanUat(root);
    await setHumanResult(root, "UAT-010", "FAIL");

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "requires every scenario to PASS",
    );
  });

  it("accepts internally complete human UAT approval", async () => {
    const root = await packageCopy();
    await completeHumanUat(root);

    await expect(validateUatPackage(root)).resolves.toEqual([]);
  });

  it("keeps SECURITY-READINESS independent after human UAT approval", async () => {
    const root = await packageCopy();
    await completeHumanUat(root);
    const readiness = await readJson(root, "uat-readiness.json");

    expect(readiness.securityReadiness).toBe("NOT_APPROVED");
    await expect(validateUatPackage(root)).resolves.toEqual([]);
  });

  it("rejects unknown scenario IDs and statuses", async () => {
    const root = await packageCopy();
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      const result = recordAt(results, 0);
      result.scenario = "UAT-999";
      result.status = "UNKNOWN";
    });

    const issues = (await validateUatPackage(root)).join("\n");
    expect(issues).toContain("each known scenario exactly once");
    expect(issues).toContain("invalid result status");
  });

  it("rejects secret-shaped human evidence", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");
    const secretShapedName = ["ABCDE", "FGHIJ", "KLMNO"].join("-");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      recordById(results, "scenario", "UAT-001").evidence = [
        `artifacts/user-acceptance/evidence/${secretShapedName}.png`,
      ];
    });

    const issues = (await validateUatPackage(root)).join("\n");
    expect(issues).toContain("unsafe evidence reference");
    expect(issues).toContain("secret-shaped material");
  });

  it("rejects unsafe absolute and traversal evidence paths", async () => {
    const root = await packageCopy();
    await setExecutable(root, "UAT-001");
    await setHumanResult(root, "UAT-001", "PASS");
    await setHumanAcceptance(root, "IN_REVIEW");
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      recordById(results, "scenario", "UAT-001").evidence = [
        "C:/Users/reviewer/evidence.png",
        "artifacts/user-acceptance/../outside.png",
      ];
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "unsafe evidence reference",
    );
  });
});

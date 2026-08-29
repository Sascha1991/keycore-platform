import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateUatPackage } from "../../scripts/validate-uat.js";

const temporaryRoots: string[] = [];

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

async function editJson(
  root: string,
  name: string,
  edit: (document: Record<string, unknown>) => void,
): Promise<void> {
  const filePath = path.join(root, "artifacts", "user-acceptance", name);
  const document = JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
  edit(document);
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("KS-11-07 UAT package validator", () => {
  it("accepts the deterministic initial package without human acceptance", async () => {
    await expect(validateUatPackage()).resolves.toEqual([]);
  });

  it("rejects duplicate or missing scenario IDs", async () => {
    const root = await packageCopy();
    await editJson(root, "uat-readiness.json", (document) => {
      const scenarios = document.scenarios as Record<string, unknown>[];
      recordAt(scenarios, 1).id = "UAT-001";
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "scenario IDs must occur exactly once",
    );
  });

  it("rejects fabricated human PASS results", async () => {
    const root = await packageCopy();
    await editJson(root, "uat-results.json", (document) => {
      const results = document.results as Record<string, unknown>[];
      const result = recordAt(results, 0);
      result.status = "PASS";
      result.reviewer = "fabricated-reviewer";
      result.reviewedAt = "2030-01-01T00:00:00Z";
    });

    const issues = (await validateUatPackage(root)).join("\n");
    expect(issues).toContain("must not fabricate reviewer or reviewedAt");
    expect(issues).toContain("must not be PASS");
  });

  it("rejects automated or fabricated approval", async () => {
    const root = await packageCopy();
    await editJson(root, "human-approval.json", (document) => {
      document.approval = "APPROVED";
      document.reviewer = "automation";
      document.approvedAt = "2030-01-01T00:00:00Z";
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "must remain NOT_APPROVED",
    );
  });

  it("rejects non-executable scenarios without a concrete dependency", async () => {
    const root = await packageCopy();
    await editJson(root, "uat-readiness.json", (document) => {
      const scenarios = document.scenarios as Record<string, unknown>[];
      delete recordAt(scenarios, 0).targetDependency;
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "requires a reason and target dependency",
    );
  });

  it("rejects unsafe evidence paths", async () => {
    const root = await packageCopy();
    await editJson(root, "uat-supporting-evidence.json", (document) => {
      const sources = document.sources as Record<string, unknown>[];
      recordAt(sources, 0).path = "../outside/evidence.json";
    });

    expect((await validateUatPackage(root)).join("\n")).toContain(
      "unsafe path",
    );
  });
});

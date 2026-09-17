import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { scanSecretText } from "./secret-patterns.mjs";

const root = process.cwd();
const ignoredFiles = new Set(["package-lock.json"]);

const repositoryFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => !ignoredFiles.has(path.basename(file)));

const findings = [];

for (const relativePath of repositoryFiles) {
  const filePath = path.join(root, relativePath);

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    continue;
  }

  for (const findingClass of scanSecretText(content)) {
    findings.push(`${relativePath}: ${findingClass}`);
  }
}

if (findings.length > 0) {
  console.error("Potential secret or product-key leakage found:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log("Secret scan passed.");
}

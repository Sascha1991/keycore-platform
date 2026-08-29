import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { scanSecretText } from "./secret-patterns.mjs";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".docker-data",
  ".wordpress",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

const ignoredFiles = new Set(["package-lock.json"]);

async function* walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        yield* walk(fullPath);
      }
      continue;
    }

    if (entry.isFile() && !ignoredFiles.has(entry.name)) {
      yield fullPath;
    }
  }
}

const findings = [];

for await (const filePath of walk(root)) {
  const relativePath = path.relative(root, filePath);

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

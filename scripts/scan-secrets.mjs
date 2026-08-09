import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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

const checks = [
  {
    name: "live Stripe secret key",
    pattern: /sk_live_[A-Za-z0-9]{12,}/,
  },
  {
    name: "GitHub token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/,
  },
  {
    name: "AWS access key",
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: "private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "non-test product key pattern",
    pattern:
      /(?<!TEST-)\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}(?:-[A-Z0-9]{5})?\b/,
  },
  {
    name: "hard-coded secret assignment",
    pattern:
      /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'<>{}\s]{8,}["']/i,
  },
];

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

  for (const check of checks) {
    if (check.pattern.test(content)) {
      findings.push(`${relativePath}: ${check.name}`);
    }
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

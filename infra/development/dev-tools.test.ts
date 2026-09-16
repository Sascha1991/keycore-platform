import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LOG_TAIL,
  composeArgs,
  createLocalEnvValues,
  logsArgs,
  parseAheadBehind,
  parseComposePs,
  parseEnv,
  renderLocalEnv,
  serviceReadiness,
  stopArgs,
  toolchainReport,
  validateLocalEnv,
} from "../../scripts/dev-tools.mjs";

const deterministicRandom = (size: number): Buffer =>
  Buffer.alloc(size, Math.max(1, size % 251));

describe("multi-device development tooling", () => {
  it("creates a complete local-only environment without unresolved placeholders", () => {
    const template = readFileSync("infra/docker/staging.env.example", "utf8");
    const rendered = renderLocalEnv(
      template,
      createLocalEnvValues(deterministicRandom),
    );
    const report = validateLocalEnv(parseEnv(rendered), parseEnv(template));

    expect(report).toEqual({
      errors: [],
      missing: [],
      placeholders: [],
      templateDrift: [],
    });
    expect(rendered).toContain("KEYCORE_ENV=STAGING");
    expect(rendered).toContain("KEYRANO_STAGING_ORIGIN=http://localhost:18080");
    expect(rendered).not.toContain("replace-with");
    expect(rendered).not.toContain("GENERATE_LOCALLY");
  });

  it("keeps generated secrets out of CLI output and never overwrites the env file", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");

    expect(cli).toContain("if (existsSync(LOCAL_ENV_PATH))");
    expect(cli).toContain('flag: "wx"');
    expect(cli).toContain("Geheimwerte wurden nicht ausgegeben");
    expect(cli).not.toContain("console.log(rendered)");
  });

  it("stops without deleting volumes", () => {
    expect(stopArgs()).toEqual(composeArgs("down"));
    expect(stopArgs()).not.toContain("--volumes");
    expect(stopArgs()).not.toContain("-v");
  });

  it("bounds logs and resolves only known service aliases", () => {
    expect(logsArgs("admin")).toEqual([
      ...composeArgs("logs", "--tail", String(LOG_TAIL)),
      "keycore-admin",
    ]);
    expect(() => logsArgs("unknown")).toThrow("Unbekannter Dienst");
  });

  it("reports actual compose readiness without inventing missing services", () => {
    const rows = parseComposePs(
      [
        JSON.stringify({
          Service: "postgres",
          State: "running",
          Health: "healthy",
        }),
        JSON.stringify({
          Service: "redis",
          State: "running",
          Health: "starting",
        }),
      ].join("\n"),
    );
    const readiness = serviceReadiness(rows);

    expect(readiness.find((item) => item.service === "postgres")?.ready).toBe(
      true,
    );
    expect(readiness.find((item) => item.service === "redis")?.ready).toBe(
      false,
    );
    expect(readiness.find((item) => item.service === "mail")).toMatchObject({
      ready: false,
      state: "missing",
    });
  });

  it("enforces the pinned Node and npm toolchain", () => {
    expect(
      toolchainReport({ nodeVersion: "v22.22.0", npmVersion: "11.6.2" }),
    ).toMatchObject({
      node: true,
      npm: true,
    });
    expect(
      toolchainReport({ nodeVersion: "v24.0.0", npmVersion: "10.9.0" }),
    ).toMatchObject({
      node: false,
      npm: false,
    });
  });

  it("maps git left/right counts to behind/ahead correctly", () => {
    expect(parseAheadBehind("3 5")).toEqual({ behind: 3, ahead: 5 });
  });

  it("keeps the handoff command read-only", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");
    const handoffBlock = cli.slice(
      cli.indexOf("const handoff"),
      cli.indexOf("const check"),
    );

    expect(handoffBlock).toContain('"status"');
    expect(handoffBlock).toContain('"rev-list"');
    expect(handoffBlock).not.toMatch(/fetch|pull|push|reset|stash|commit/u);
  });

  it("protects known machine-local files through tracked ignore rules", () => {
    const ignore = readFileSync(".gitignore", "utf8");

    expect(ignore).toContain("infra/docker/staging.local.env");
    expect(ignore).toContain("Server Login Staging Daten.txt");
    expect(ignore).toContain("keycore-postgres-*.dump");
  });

  it("uses the existing compose stack for normal starts", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");

    expect(cli).toContain('["up", "-d", "--build", ...expectedServices]');
    expect(composeArgs("config", "--quiet")).toContain(
      "infra/docker/compose.staging.yaml",
    );
  });

  it("keeps status read-only", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");
    const statusBlock = cli.slice(
      cli.indexOf("const printStatus"),
      cli.indexOf("const handoff"),
    );

    expect(statusBlock).toContain('"ps"');
    expect(statusBlock).not.toMatch(/\b(up|down|start|stop|restart|rm)\b/u);
  });

  it("keeps required PHP validation portable on Windows", () => {
    const composer = readFileSync("composer.json", "utf8");
    const linter = readFileSync("scripts/php-lint.php", "utf8");

    expect(composer).toContain("php scripts/php-lint.php");
    expect(composer).not.toMatch(/find .*xargs/u);
    expect(linter).toContain("RecursiveDirectoryIterator");
    expect(linter).toContain("PHP_BINARY");
  });

  it("documents every required PC 1 and PC 2 workflow with real commands", () => {
    const guide = readFileSync(
      "docs/development/MULTI-DEVICE-DEVELOPMENT.md",
      "utf8",
    );

    for (const heading of [
      "## A. PC 2 - Ersteinrichtung",
      "## B. PC 1 - Normaler Arbeitsbeginn",
      "## C. Wechsel PC 1 zu PC 2",
      "## D. PC 2 - Normaler Arbeitsbeginn",
      "## E. Wechsel PC 2 zu PC 1",
      "## F. Arbeitsende ohne Gerätewechsel",
      "## G. Tests und Prüfungen",
      "## H. Status, Logs und Diagnose",
      "## I. Git-Fehler und Sonderfälle",
      "## J. Docker- und Startprobleme",
      "## K. Datenbank- und Migrationsprobleme",
      "## L. Optionale PostgreSQL-Kopie PC 1 zu PC 2",
      "## M. Was tun, wenn sich das Projekt geändert hat?",
      "## N. Checklisten PC 1 und PC 2",
    ]) {
      expect(guide).toContain(heading);
    }
    expect(guide).toMatch(
      /\|\s*Schritt\/Situation\s*\|\s*Rechner\s*\|\s*Zeitpunkt\s*\|\s*Wo\?/u,
    );
    for (const script of [
      "setup",
      "start",
      "status",
      "logs",
      "check",
      "stop",
    ]) {
      expect(guide).toContain(`npm run dev:${script}`);
    }
  });
});

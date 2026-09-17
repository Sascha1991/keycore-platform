import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  IMPORT_CONFIRMATION,
  LOG_TAIL,
  assertImportConfirmation,
  assertRequestedDevice,
  composeArgs,
  createTransferManifest,
  createLocalEnvValues,
  finishDecision,
  gitStartDecision,
  isPathInside,
  logsArgs,
  normalizeDeviceId,
  parseAheadBehind,
  parseChecksumFile,
  parseComposePs,
  parseDeviceConfig,
  parseEnv,
  renderLocalEnv,
  serviceReadiness,
  stopArgs,
  toolchainReport,
  transferSecretDependencies,
  transferSidecarPaths,
  validateLocalEnv,
  validateTransferManifest,
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

  it("validates isolated local port overrides without weakening local-only origins", () => {
    const template = readFileSync("infra/docker/staging.env.example", "utf8");
    const env = {
      ...parseEnv(
        renderLocalEnv(template, createLocalEnvValues(deterministicRandom)),
      ),
      KEYCORE_STAGING_ADMIN_PORT: "28081",
      KEYCORE_STAGING_WORDPRESS_PORT: "28080",
      KEYRANO_STAGING_ADMIN_ORIGIN: "http://localhost:28081",
      KEYRANO_STAGING_ORIGIN: "http://localhost:28080",
    };

    expect(validateLocalEnv(env, parseEnv(template)).errors).toEqual([]);
    expect(
      validateLocalEnv(
        { ...env, KEYRANO_STAGING_ADMIN_ORIGIN: "https://example.test" },
        parseEnv(template),
      ).errors,
    ).toContain(
      "KEYRANO_STAGING_ADMIN_ORIGIN muss lokal http://localhost:28081 sein.",
    );
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

  it("binds workflows to an explicit local device without hardware fingerprinting", () => {
    expect(normalizeDeviceId("pc-1")).toBe("PC-1");
    expect(parseDeviceConfig('{"version":1,"deviceId":"LAPTOP"}')).toEqual({
      deviceId: "LAPTOP",
      version: 1,
    });
    expect(assertRequestedDevice("PC-2", "PC-2")).toBe("PC-2");
    expect(() => assertRequestedDevice("PC-2", "PC-1")).toThrow(
      "Geräte-ID stimmt nicht überein",
    );
    expect(() => normalizeDeviceId("WORKSTATION-9")).toThrow(
      "Ungültige Geräte-ID",
    );
  });

  it("selects only lossless Start-Work synchronization paths", () => {
    expect(
      gitStartDecision({
        ahead: 0,
        behind: 1,
        dirty: false,
        hasUpstream: true,
      }),
    ).toBe("FAST_FORWARD");
    expect(
      gitStartDecision({ ahead: 0, behind: 0, dirty: true, hasUpstream: true }),
    ).toBe("BLOCK_DIRTY");
    expect(
      gitStartDecision({
        ahead: 1,
        behind: 1,
        dirty: false,
        hasUpstream: true,
      }),
    ).toBe("BLOCK_DIVERGED");
    expect(
      gitStartDecision({
        ahead: 2,
        behind: 0,
        dirty: false,
        hasUpstream: true,
      }),
    ).toBe("READY");
  });

  it("allows Finish-Work handoff only when Git is clean and synchronized", () => {
    expect(
      finishDecision({ ahead: 0, behind: 0, dirty: false, hasUpstream: true }),
    ).toBe("SAFE_TO_HANDOFF");
    expect(
      finishDecision({ ahead: 0, behind: 0, dirty: true, hasUpstream: true }),
    ).toBe("BLOCK_DIRTY");
    expect(
      finishDecision({ ahead: 1, behind: 0, dirty: false, hasUpstream: true }),
    ).toBe("BLOCK_AHEAD");
    expect(
      finishDecision({ ahead: 0, behind: 1, dirty: false, hasUpstream: true }),
    ).toBe("BLOCK_BEHIND");
  });

  it("validates PostgreSQL transfer manifests, hashes and paths with spaces", () => {
    const dumpPath =
      "C:\\Users\\Example User\\KeyCore Transfers\\keycore-postgres-review.dump";
    const sidecars = transferSidecarPaths(dumpPath);
    const sha256 = "a".repeat(64);
    const manifest = createTransferManifest({
      branch: "feature/example",
      commit: "b".repeat(40),
      createdAt: "2026-09-16T12:00:00.000Z",
      deviceId: "PC-1",
      dumpFile: "keycore-postgres-review.dump",
      migrationCount: 36,
      migrationLatest: "036",
      sha256,
    });

    expect(sidecars.checksumPath).toBe(`${dumpPath}.sha256`);
    expect(sidecars.manifestPath).toBe(`${dumpPath}.manifest.json`);
    expect(
      parseChecksumFile(
        `${sha256}  keycore-postgres-review.dump\n`,
        "keycore-postgres-review.dump",
      ),
    ).toBe(sha256);
    expect(() =>
      parseChecksumFile("not-a-checksum", "keycore-postgres-review.dump"),
    ).toThrow("SHA-256-Datei ist ungültig");
    expect(
      validateTransferManifest({
        actualSha256: sha256,
        dumpFile: "keycore-postgres-review.dump",
        manifest,
        sidecarSha256: sha256,
      }),
    ).toEqual([]);
    expect(
      validateTransferManifest({
        actualSha256: "c".repeat(64),
        dumpFile: "keycore-postgres-review.dump",
        manifest,
        sidecarSha256: sha256,
      }),
    ).toEqual(
      expect.arrayContaining([
        "MANIFEST_HASH_MISMATCH",
        "SIDECAR_HASH_MISMATCH",
      ]),
    );
    expect(isPathInside("C:\\repo", dumpPath)).toBe(false);
    expect(isPathInside("C:\\repo", "C:\\repo\\review.dump")).toBe(true);
  });

  it("requires explicit destructive import confirmation", () => {
    expect(() => assertImportConfirmation(undefined)).toThrow(
      IMPORT_CONFIRMATION,
    );
    expect(() => assertImportConfirmation("yes")).toThrow(IMPORT_CONFIRMATION);
    expect(() => assertImportConfirmation(IMPORT_CONFIRMATION)).not.toThrow();
  });

  it("documents only PostgreSQL-transfer-relevant secret dependencies", () => {
    expect(Object.keys(transferSecretDependencies).sort()).toEqual([
      "KEYCORE_FULFILLMENT_MASTER_KEY",
      "KEYCORE_FULFILLMENT_MASTER_KEY_ID",
      "KEYRANO_STAGING_GUEST_CLAIM_CODE",
    ]);
    expect(transferSecretDependencies).not.toHaveProperty(
      "KEYRANO_STAGING_BROWSER_MASTER_KEY",
    );
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

  it("uses fast-forward-only Start-Work and never commits or pushes on Finish-Work", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");
    const startBlock = cli.slice(
      cli.indexOf("const startWork"),
      cli.indexOf("const finishWork"),
    );
    const finishBlock = cli.slice(
      cli.indexOf("const finishWork"),
      cli.indexOf("const databaseExport"),
    );

    expect(startBlock).toContain('"merge", "--ff-only"');
    expect(startBlock).not.toMatch(/\b(?:pull|reset|stash)\b/u);
    expect(finishBlock).not.toMatch(
      /run\("git", \["(?:commit|push|reset|stash)"/u,
    );
    expect(finishBlock).toContain("Der Stack bleibt gestartet");
  });

  it("uses safe PostgreSQL custom dump, restore and recovery primitives", () => {
    const cli = readFileSync("scripts/dev.mjs", "utf8");

    expect(cli).toContain('"--format=custom"');
    expect(cli).toContain('"--no-owner"');
    expect(cli).toContain('"--no-privileges"');
    expect(cli).toContain('"--exit-on-error"');
    expect(cli).toContain('label: "pre-import-recovery"');
    expect(cli).toContain("automatische Recovery");
    expect(cli).not.toContain("console.log(env)");
  });

  it("preserves the existing Admin credential bootstrap fix", () => {
    const bootstrap = readFileSync(
      "scripts/staging-admin-bootstrap-service.ts",
      "utf8",
    );
    const envExample = readFileSync("infra/docker/staging.env.example", "utf8");

    expect(bootstrap).toContain("ON CONFLICT (id) DO NOTHING");
    expect(bootstrap).toContain("identity.email_normalized IS NULL");
    expect(bootstrap).toContain("input.credential.rotateExisting === true");
    expect(envExample).toContain(
      "KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE=false",
    );
  });

  it("maps all six Codex device commands to the repository CLI", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    for (const [human, script] of [
      ["Start-Work-PC-1", "npm run dev:work-start -- PC-1"],
      ["Finish-Work-PC-1", "npm run dev:work-finish -- PC-1"],
      ["Start-Work-PC-2", "npm run dev:work-start -- PC-2"],
      ["Finish-Work-PC-2", "npm run dev:work-finish -- PC-2"],
      ["Start-Work-Laptop", "npm run dev:work-start -- LAPTOP"],
      ["Finish-Work-Laptop", "npm run dev:work-finish -- LAPTOP"],
    ]) {
      expect(agents).toContain(human);
      expect(agents).toContain(script);
    }
    expect(agents).toContain("KeyCore");
    expect(agents).toContain("KeyRaNo");
  });

  it("protects known machine-local files through tracked ignore rules", () => {
    const ignore = readFileSync(".gitignore", "utf8");

    expect(ignore).toContain("infra/docker/staging.local.env");
    expect(ignore).toContain(".keycore-device.json");
    expect(ignore).toContain("Server Login Staging Daten.txt");
    expect(ignore).toContain("keycore-postgres-*.dump");
    expect(ignore).toContain("keycore-postgres-*.dump.manifest.json");
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

  it("accepts native Windows line endings without rewriting the repository", () => {
    const prettier = JSON.parse(
      readFileSync(".prettierrc.json", "utf8"),
    ) as Record<string, unknown>;

    expect(prettier.endOfLine).toBe("auto");
  });

  it("documents the two ready devices and the PC 2 onboarding workflow", () => {
    const guide = readFileSync(
      "docs/development/MULTI-DEVICE-DEVELOPMENT.md",
      "utf8",
    );

    for (const heading of [
      "## A. PC 2 - New-Device-Onboarding",
      "## B. PC 1 - Normaler Arbeitsbeginn",
      "## C. Wechsel PC 1 zum Laptop",
      "## D. Laptop - Normaler Arbeitsbeginn",
      "## E. Wechsel Laptop zu PC 1",
      "## F. Arbeitsende ohne Gerätewechsel",
      "## G. Tests und Prüfungen",
      "## H. Status, Logs und Diagnose",
      "## I. Git-Fehler und Sonderfälle",
      "## J. Docker- und Startprobleme",
      "## K. Datenbank- und Migrationsprobleme",
      "## L. Bewusster PostgreSQL-Review-Datentransfer",
      "## M. Was tun, wenn sich das Projekt geändert hat?",
      "## N. Checklisten PC 1, PC 2 und Laptop",
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
      "device",
      "work-start",
      "work-finish",
      "db-export",
      "db-import",
    ]) {
      expect(guide).toContain(`npm run dev:${script}`);
    }
    const transferSection = guide.slice(
      guide.indexOf("## L. Bewusster PostgreSQL-Review-Datentransfer"),
      guide.indexOf("## M. Was tun, wenn sich das Projekt geändert hat?"),
    );
    expect(transferSection).toContain(
      "KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE=true",
    );
    expect(transferSection).toContain(
      "`KEYRANO_STAGING_BROWSER_MASTER_KEY` wird nicht übertragen",
    );
    expect(transferSection).toContain(
      "`KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET` darf deshalb PC-2-lokal bleiben",
    );
    expect(guide).toContain("`PC-1` ist der Haupt-PC");
    expect(guide).toContain("`LAPTOP` ist vollständig eingerichtet");
    expect(guide).toContain("`PC-2` ist der Büro-PC in der Matrix Bochum");
    expect(guide).toContain("Der Laptop ist kein Onboarding-Ziel mehr");
  });
});

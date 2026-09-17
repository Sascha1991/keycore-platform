#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  COMPOSE_FILE,
  DEVICE_CONFIG_PATH,
  ENV_TEMPLATE_PATH,
  IMPORT_CONFIRMATION,
  LOCAL_ENV_PATH,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_MAJOR,
  assertImportConfirmation,
  assertRequestedDevice,
  composeArgs,
  createTransferManifest,
  createLocalEnvValues,
  expectedServices,
  finishDecision,
  gitStartDecision,
  isPathInside,
  logsArgs,
  normalizeDeviceId,
  parseChecksumFile,
  parseAheadBehind,
  parseComposePs,
  parseDeviceConfig,
  parseEnv,
  renderLocalEnv,
  serviceReadiness,
  stopArgs,
  toolchainReport,
  transferSidecarPaths,
  validateLocalEnv,
  validateTransferManifest,
} from "./dev-tools.mjs";

const command = process.argv[2] ?? "help";
const commandArgs = process.argv.slice(3);
const root = process.cwd();

const executable = (name) =>
  process.platform === "win32" && ["npm", "npx"].includes(name)
    ? `${name}.cmd`
    : name;

const run = (name, args, options = {}) => {
  const npmViaCurrentNode =
    name === "npm" && typeof process.env.npm_execpath === "string";
  const program = npmViaCurrentNode ? process.execPath : executable(name);
  const programArgs = npmViaCurrentNode
    ? [process.env.npm_execpath, ...args]
    : args;
  const result = spawnSync(program, programArgs, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? (result.stderr || result.stdout).trim()
      : "";
    throw new Error(
      `${name} ${args.join(" ")} ist fehlgeschlagen${detail ? `: ${detail}` : "."}`,
    );
  }
  return result;
};

const capture = (name, args, options = {}) =>
  run(name, args, { ...options, capture: true }).stdout.trim();

const assertRepositoryRoot = () => {
  if (!existsSync("package.json") || !existsSync(COMPOSE_FILE)) {
    throw new Error(
      "Bitte den Befehl im Wurzelverzeichnis des KeyCore-Repositories ausführen.",
    );
  }
};

const versionOf = (name, args = ["--version"]) => {
  const result = run(name, args, { allowFailure: true, capture: true });
  return result.status === 0 ? result.stdout.trim() : "nicht gefunden";
};

const assertPrerequisites = () => {
  const report = toolchainReport({
    nodeVersion: process.version,
    npmVersion: versionOf("npm"),
  });
  const git = versionOf("git");
  const docker = versionOf("docker");
  const compose = versionOf("docker", ["compose", "version", "--short"]);
  const failures = [];
  if (!report.node) {
    failures.push(
      `Node.js ${REQUIRED_NODE_VERSION} erforderlich; gefunden: ${report.nodeDetected}.`,
    );
  }
  if (!report.npm) {
    failures.push(
      `npm Major ${REQUIRED_NPM_MAJOR} erforderlich; gefunden: ${report.npmDetected}.`,
    );
  }
  if (git === "nicht gefunden") failures.push("Git wurde nicht gefunden.");
  if (docker === "nicht gefunden")
    failures.push("Docker wurde nicht gefunden.");
  if (compose === "nicht gefunden") {
    failures.push("Docker Compose v2 wurde nicht gefunden.");
  }
  if (docker !== "nicht gefunden") {
    const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      allowFailure: true,
      capture: true,
    });
    if (daemon.status !== 0) {
      failures.push(
        "Docker Desktop ist nicht gestartet oder nicht erreichbar.",
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.join("\n")}\nSiehe docs/development/MULTI-DEVICE-DEVELOPMENT.md.`,
    );
  }
  console.log(`Node.js ${report.nodeDetected}; npm ${report.npmDetected}`);
  console.log(`${git}; ${docker}; Docker Compose ${compose}`);
};

const assertDockerAvailable = () => {
  const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    allowFailure: true,
    capture: true,
  });
  if (daemon.status !== 0) {
    throw new Error(
      "Docker Desktop ist nicht gestartet oder nicht erreichbar.",
    );
  }
};

const loadLocalEnv = async () => {
  if (!existsSync(LOCAL_ENV_PATH)) {
    throw new Error(
      `${LOCAL_ENV_PATH} fehlt. Zuerst \"npm run dev:setup\" ausführen.`,
    );
  }
  const [content, template] = await Promise.all([
    readFile(LOCAL_ENV_PATH, "utf8"),
    readFile(ENV_TEMPLATE_PATH, "utf8"),
  ]);
  const env = parseEnv(content);
  const validation = validateLocalEnv(env, parseEnv(template));
  const problems = [
    ...validation.errors,
    ...validation.missing.map((key) => `${key} fehlt.`),
    ...validation.placeholders.map(
      (key) => `${key} enthält einen Platzhalter.`,
    ),
    ...validation.templateDrift.map(
      (key) => `${key} aus der Vorlage fehlt in der lokalen Datei.`,
    ),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Lokale Konfiguration ist nicht einsatzbereit:\n- ${problems.join("\n- ")}`,
    );
  }
  return { ...process.env, ...env };
};

const createLocalEnv = async () => {
  if (existsSync(LOCAL_ENV_PATH)) {
    console.log(`${LOCAL_ENV_PATH} bleibt unverändert bestehen.`);
    return false;
  }
  const template = await readFile(ENV_TEMPLATE_PATH, "utf8");
  const rendered = renderLocalEnv(template, createLocalEnvValues());
  await mkdir(path.dirname(LOCAL_ENV_PATH), { recursive: true });
  const temporary = `${LOCAL_ENV_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { encoding: "utf8", flag: "wx" });
  await rename(temporary, LOCAL_ENV_PATH);
  console.log(
    `${LOCAL_ENV_PATH} wurde lokal erzeugt. Geheimwerte wurden nicht ausgegeben.`,
  );
  return true;
};

const configureDevice = async (requestedDeviceId) => {
  const requested = normalizeDeviceId(requestedDeviceId);
  if (existsSync(DEVICE_CONFIG_PATH)) {
    const configured = parseDeviceConfig(
      await readFile(DEVICE_CONFIG_PATH, "utf8"),
    );
    assertRequestedDevice(configured.deviceId, requested);
    console.log(`Lokale Geräte-ID bleibt ${configured.deviceId}.`);
    return configured;
  }
  const config = Object.freeze({ deviceId: requested, version: 1 });
  await writeFile(DEVICE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(`Lokale Geräte-ID ${requested} wurde eingerichtet.`);
  return config;
};

const loadDeviceConfig = async (requestedDeviceId) => {
  if (!existsSync(DEVICE_CONFIG_PATH)) {
    throw new Error(
      `${DEVICE_CONFIG_PATH} fehlt. Einmalig "npm run dev:device -- PC-1|PC-2|LAPTOP" ausführen.`,
    );
  }
  const config = parseDeviceConfig(await readFile(DEVICE_CONFIG_PATH, "utf8"));
  if (requestedDeviceId) {
    assertRequestedDevice(config.deviceId, requestedDeviceId);
  }
  return config;
};

const assertExpectedRemote = () => {
  const remote = capture("git", ["remote", "get-url", "origin"]);
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)Sascha1991\/keycore-platform(?:\.git)?$/u.test(
      remote,
    )
  ) {
    throw new Error("origin verweist nicht auf Sascha1991/keycore-platform.");
  }
};

const gitSnapshot = () => {
  const status = capture("git", ["status", "--porcelain"]);
  const upstreamResult = run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true, capture: true },
  );
  if (upstreamResult.status !== 0) {
    return Object.freeze({
      ahead: 0,
      behind: 0,
      dirty: Boolean(status),
      hasUpstream: false,
      status,
      upstream: "",
    });
  }
  const upstream = upstreamResult.stdout.trim();
  const counts = parseAheadBehind(
    capture("git", [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ]),
  );
  return Object.freeze({
    ...counts,
    dirty: Boolean(status),
    hasUpstream: true,
    status,
    upstream,
  });
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const safeUnlink = async (filePath) => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const databaseCoordinates = (env) => {
  const databaseUrl = new URL(env.KEYCORE_DATABASE_URL);
  return Object.freeze({
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//u, "")),
    user: decodeURIComponent(databaseUrl.username),
  });
};

const postgresContainerId = () => {
  const containerId = capture("docker", composeArgs("ps", "-q", "postgres"));
  if (!containerId)
    throw new Error("Der lokale PostgreSQL-Container läuft nicht.");
  return containerId;
};

const migrationIdentity = (env) => {
  const { database, user } = databaseCoordinates(env);
  const result = capture(
    "docker",
    composeArgs(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-At",
      "-c",
      "SELECT count(*)::text || '|' || COALESCE(max(version)::text, '') FROM keycore_migrations;",
    ),
  );
  const [count, latest] = result.split("|");
  return Object.freeze({
    count: Number.parseInt(count ?? "0", 10),
    latest: latest ?? "",
  });
};

const transferDirectoryFrom = (requestedPath) => {
  const directory = path.resolve(
    requestedPath || path.join(os.homedir(), "KeyCore-Transfers"),
  );
  if (isPathInside(root, directory)) {
    throw new Error(
      "Der Transferordner muss außerhalb des Repositories liegen.",
    );
  }
  return directory;
};

const transferStamp = () => new Date().toISOString().replace(/[:.]/gu, "-");

const compose = (args, options = {}) =>
  run("docker", composeArgs(...args), options);

const projectName = (env) => `keycore-${env.KEYCORE_DEPLOYMENT_ID}`;
const volumeNames = (env) => [
  `${projectName(env)}_postgres-data`,
  `${projectName(env)}_redis-data`,
  `${projectName(env)}_wordpress-data`,
  `${projectName(env)}_wordpress-db-data`,
];

const inspectVolumeState = (env) => {
  const existing = volumeNames(env).filter((volume) => {
    const result = run("docker", ["volume", "inspect", volume], {
      allowFailure: true,
      capture: true,
    });
    return result.status === 0;
  });
  if (existing.length !== 0 && existing.length !== volumeNames(env).length) {
    throw new Error(
      "Der lokale Stack besitzt nur einen Teil seiner erwarteten Volumes. Aus Sicherheitsgründen erfolgt keine automatische Reparatur.",
    );
  }
  return existing.length === 0 ? "fresh" : "existing";
};

const createDatabaseExport = async ({
  directory,
  deviceId,
  label = "transfer",
}) => {
  const env = await loadLocalEnv();
  const { database, user } = databaseCoordinates(env);
  const targetDirectory = transferDirectoryFrom(directory);
  await mkdir(targetDirectory, { recursive: true });
  const fileName = `keycore-postgres-${label}-${transferStamp()}.dump`;
  const dumpPath = path.join(targetDirectory, fileName);
  const { checksumPath, manifestPath } = transferSidecarPaths(dumpPath);
  for (const target of [dumpPath, checksumPath, manifestPath]) {
    if (existsSync(target))
      throw new Error(`Zieldatei existiert bereits: ${target}`);
  }
  try {
    compose([
      "exec",
      "-T",
      "postgres",
      "pg_isready",
      "-U",
      user,
      "-d",
      database,
    ]);
    const identity = migrationIdentity(env);
    const containerId = postgresContainerId();
    const containerDump = `/tmp/${fileName}`;
    try {
      compose([
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        user,
        "-d",
        database,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--file=${containerDump}`,
      ]);
      run("docker", ["cp", `${containerId}:${containerDump}`, dumpPath]);
    } finally {
      compose(["exec", "-T", "postgres", "rm", "-f", containerDump], {
        allowFailure: true,
      });
    }

    const dumpStat = await stat(dumpPath);
    if (!dumpStat.isFile() || dumpStat.size === 0) {
      throw new Error("PostgreSQL-Dump ist leer oder ungültig.");
    }
    const sha256 = await sha256File(dumpPath);
    const manifest = createTransferManifest({
      branch: capture("git", ["branch", "--show-current"]),
      commit: capture("git", ["rev-parse", "HEAD"]),
      createdAt: new Date().toISOString(),
      deviceId,
      dumpFile: fileName,
      migrationCount: identity.count,
      migrationLatest: identity.latest,
      sha256,
    });
    await writeFile(checksumPath, `${sha256}  ${fileName}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(`PostgreSQL-Transferpaket erstellt: ${dumpPath}`);
    console.log(
      "SHA-256 und Manifest wurden erstellt; keine Secrets ausgegeben.",
    );
    return Object.freeze({ dumpPath, manifest });
  } catch (error) {
    await Promise.all(
      [dumpPath, checksumPath, manifestPath].map((target) =>
        safeUnlink(target),
      ),
    );
    throw error;
  }
};

const copyDumpToContainer = (dumpPath, containerPath) => {
  const containerId = postgresContainerId();
  run("docker", ["cp", dumpPath, `${containerId}:${containerPath}`]);
};

const restoreContainerDump = (env, containerPath) => {
  const { database, user } = databaseCoordinates(env);
  compose([
    "exec",
    "-T",
    "postgres",
    "dropdb",
    "-U",
    user,
    "--force",
    "--if-exists",
    database,
  ]);
  compose([
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    user,
    "-O",
    user,
    database,
  ]);
  compose([
    "exec",
    "-T",
    "postgres",
    "pg_restore",
    "-U",
    user,
    "-d",
    database,
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    containerPath,
  ]);
};

const validateImportPackage = async (dumpArgument, confirmation) => {
  assertImportConfirmation(confirmation);
  if (!dumpArgument) throw new Error("Pfad zum PostgreSQL-Dump fehlt.");
  const dumpPath = path.resolve(dumpArgument);
  if (isPathInside(root, dumpPath)) {
    throw new Error("Der PostgreSQL-Dump darf nicht im Repository liegen.");
  }
  const { checksumPath, manifestPath } = transferSidecarPaths(dumpPath);
  for (const required of [dumpPath, checksumPath, manifestPath]) {
    if (!existsSync(required))
      throw new Error(`Transferdatei fehlt: ${required}`);
  }
  const [checksumContent, manifestContent, actualSha256] = await Promise.all([
    readFile(checksumPath, "utf8"),
    readFile(manifestPath, "utf8"),
    sha256File(dumpPath),
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new Error("Transfermanifest enthält kein gültiges JSON.");
  }
  const dumpFile = path.basename(dumpPath);
  const sidecarSha256 = parseChecksumFile(checksumContent, dumpFile);
  const errors = validateTransferManifest({
    actualSha256,
    dumpFile,
    manifest,
    sidecarSha256,
  });
  if (errors.length > 0) {
    throw new Error(`Transferpaket ist ungültig: ${errors.join(", ")}`);
  }
  const commitCheck = run(
    "git",
    ["merge-base", "--is-ancestor", manifest.commit, "HEAD"],
    { allowFailure: true, capture: true },
  );
  if (commitCheck.status !== 0) {
    throw new Error(
      "Der Dump-Commit ist kein Vorfahr des aktuellen HEAD. Import abgebrochen.",
    );
  }
  return Object.freeze({ dumpPath, manifest });
};

const waitForServices = async () => {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const output = capture("docker", composeArgs("ps", "--format", "json"));
    const readiness = serviceReadiness(parseComposePs(output));
    if (readiness.every((item) => item.ready)) return readiness;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    "Die lokalen Dienste wurden nicht rechtzeitig einsatzbereit.",
  );
};

const startStack = async () => {
  compose(["config", "--quiet"]);
  compose(["up", "-d", "--build", ...expectedServices]);
  await waitForServices();
};

const setup = async () => {
  console.log("[1/7] Voraussetzungen prüfen");
  assertPrerequisites();
  console.log("[2/7] Lokale Konfiguration vorbereiten und prüfen");
  await createLocalEnv();
  const env = await loadLocalEnv();
  const state = inspectVolumeState(env);
  console.log("[3/7] Abhängigkeiten reproduzierbar installieren");
  run("npm", ["ci"]);
  console.log("[4/7] Vollständigen lokalen Stack bauen und starten");
  await startStack();
  if (state === "fresh") {
    console.log("[5/7] Synthetische PostgreSQL-Basisdaten initialisieren");
    run("npm", ["run", "staging:seed"], { env });
    console.log("[6/7] WordPress und WooCommerce initialisieren");
    compose(["--profile", "bootstrap", "run", "--rm", "wordpress-bootstrap"]);
    console.log(
      "Frischer lokaler Stack wurde migriert und synthetisch initialisiert.",
    );
  } else {
    console.log("[5/7] Bestehende Daten erkannt");
    console.log(
      "Bestehende Volumes erkannt; Seed und WordPress-Bootstrap wurden ausgelassen.",
    );
    console.log("[6/7] Bestehende WordPress-Daten bleiben unverändert");
  }
  console.log("[7/7] Migrationen und Dienstbereitschaft prüfen");
  run("npm", ["run", "db:status"], { env });
  await printStatus(env);
};

const printStatus = async (providedEnv) => {
  const env = providedEnv ?? (await loadLocalEnv());
  const branch = capture("git", ["branch", "--show-current"]);
  const head = capture("git", ["rev-parse", "--short", "HEAD"]);
  const rows = parseComposePs(
    capture("docker", composeArgs("ps", "--format", "json")),
  );
  console.log(`Git: ${branch} @ ${head}`);
  for (const item of serviceReadiness(rows)) {
    console.log(
      `${item.ready ? "OK" : "FEHLER"} ${item.service}: ${item.state}${item.health ? `/${item.health}` : ""}`,
    );
  }
  const endpoints = [
    ["Storefront", env.KEYRANO_STAGING_ORIGIN],
    ["Admin", `${env.KEYRANO_STAGING_ADMIN_ORIGIN}/health`],
  ];
  for (const [label, url] of endpoints) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      console.log(
        `${response.status < 400 ? "OK" : "FEHLER"} ${label}-HTTP: ${response.status}`,
      );
    } catch {
      console.log(`FEHLER ${label}-HTTP: nicht erreichbar`);
    }
  }
  console.log(`Storefront: ${env.KEYRANO_STAGING_ORIGIN}`);
  console.log(`Admin: ${env.KEYRANO_STAGING_ADMIN_ORIGIN}`);
  console.log(`Mailpit: http://localhost:${env.KEYCORE_STAGING_MAIL_UI_PORT}`);
};

const handoff = () => {
  const branch = capture("git", ["branch", "--show-current"]);
  const head = capture("git", ["rev-parse", "HEAD"]);
  const status = capture("git", ["status", "--short"]);
  const upstreamResult = run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true, capture: true },
  );
  console.log(`Branch: ${branch}`);
  console.log(`HEAD: ${head}`);
  console.log(status ? `Working tree:\n${status}` : "Working tree: sauber");
  if (upstreamResult.status !== 0) {
    console.log("Upstream: nicht konfiguriert");
    return;
  }
  const upstream = upstreamResult.stdout.trim();
  const counts = parseAheadBehind(
    capture("git", [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ]),
  );
  console.log(
    `Upstream: ${upstream}; lokal voraus ${counts.ahead}, zurück ${counts.behind}`,
  );
};

const check = async () => {
  await loadLocalEnv();
  run("npm", ["run", "check"]);
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${root}:/app`,
    "-w",
    "/app",
    "composer:2.8",
    "composer",
    "check",
  ]);
  compose(["config", "--quiet"]);
};

const startWork = async (requestedDeviceId) => {
  const device = await loadDeviceConfig(requestedDeviceId);
  assertExpectedRemote();
  const beforeFetch = gitSnapshot();
  const initialDecision = gitStartDecision(beforeFetch);
  if (initialDecision === "BLOCK_DIRTY") {
    throw new Error(
      "Start-Work abgebrochen: lokale Änderungen müssen zuerst bewusst gesichert werden.",
    );
  }
  if (initialDecision === "BLOCK_NO_UPSTREAM") {
    throw new Error("Start-Work abgebrochen: kein Upstream konfiguriert.");
  }

  run("git", ["fetch", "origin", "--prune"]);
  const afterFetch = gitSnapshot();
  const decision = gitStartDecision(afterFetch);
  if (decision === "BLOCK_DIVERGED") {
    throw new Error(
      "Start-Work abgebrochen: lokaler Branch und Upstream sind divergiert. Kein stiller Merge wird durchgeführt.",
    );
  }
  if (decision === "FAST_FORWARD") {
    run("git", ["merge", "--ff-only", afterFetch.upstream]);
    return run(process.execPath, [
      path.join(root, "scripts/dev.mjs"),
      "work-start",
      device.deviceId,
    ]);
  }

  await setup();
  const finalSnapshot = gitSnapshot();
  console.log(
    `ARBEITSBEREIT: ${device.deviceId}; ${capture("git", ["branch", "--show-current"])} @ ${capture("git", ["rev-parse", "HEAD"])}; lokal voraus ${finalSnapshot.ahead}.`,
  );
};

const finishWork = async (requestedDeviceId) => {
  const device = await loadDeviceConfig(requestedDeviceId);
  assertExpectedRemote();
  handoff();
  assertPrerequisites();
  await check();
  run("git", ["fetch", "origin", "--prune"]);
  const snapshot = gitSnapshot();
  const decision = finishDecision(snapshot);
  if (decision !== "SAFE_TO_HANDOFF") {
    const reasons = {
      BLOCK_AHEAD:
        "lokale Commits sind noch nicht gepusht; Push bleibt eine bewusste Human-Aktion",
      BLOCK_BEHIND: "der lokale Branch liegt hinter dem Upstream",
      BLOCK_DIRTY:
        "der Working Tree enthält ungesicherte Änderungen; Commit bleibt eine bewusste Human-Aktion",
      BLOCK_NO_UPSTREAM: "kein Upstream ist konfiguriert",
    };
    throw new Error(
      `Finish-Work geprüft, aber Geräteübergabe ist blockiert: ${reasons[decision]}. Der Stack bleibt gestartet.`,
    );
  }
  run("docker", stopArgs());
  console.log(
    `ÜBERGABEBEREIT: ${device.deviceId}; Working Tree sauber, Upstream synchron, Stack kontrolliert gestoppt.`,
  );
};

const databaseExport = async (requestedDirectory) => {
  assertPrerequisites();
  assertExpectedRemote();
  const snapshot = gitSnapshot();
  if (snapshot.dirty) {
    throw new Error(
      "DB-Export abgebrochen: der Working Tree muss für eindeutige Commit-Metadaten sauber sein.",
    );
  }
  const device = await loadDeviceConfig();
  await loadLocalEnv();
  return createDatabaseExport({
    deviceId: device.deviceId,
    directory: requestedDirectory,
  });
};

const databaseImport = async (dumpArgument, confirmation) => {
  assertImportConfirmation(confirmation);
  assertPrerequisites();
  assertExpectedRemote();
  const snapshot = gitSnapshot();
  if (snapshot.dirty) {
    throw new Error(
      "DB-Import abgebrochen: der Working Tree muss vor einem Restore sauber sein.",
    );
  }
  const device = await loadDeviceConfig();
  const transfer = await validateImportPackage(dumpArgument, confirmation);
  const env = await loadLocalEnv();
  const { database, user } = databaseCoordinates(env);
  compose(["exec", "-T", "postgres", "pg_isready", "-U", user, "-d", database]);

  const importContainerPath = `/tmp/keycore-import-${process.pid}.dump`;
  copyDumpToContainer(transfer.dumpPath, importContainerPath);
  try {
    compose([
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--list",
      importContainerPath,
    ]);
  } catch (error) {
    compose(["exec", "-T", "postgres", "rm", "-f", importContainerPath], {
      allowFailure: true,
    });
    throw new Error(`Dump-Struktur ist ungültig: ${error.message}`);
  }

  const recoveryContainerPath = `/tmp/keycore-recovery-${process.pid}.dump`;
  let safety;
  try {
    safety = await createDatabaseExport({
      deviceId: device.deviceId,
      directory: path.dirname(transfer.dumpPath),
      label: "pre-import-recovery",
    });
    copyDumpToContainer(safety.dumpPath, recoveryContainerPath);
  } catch (error) {
    compose(
      [
        "exec",
        "-T",
        "postgres",
        "rm",
        "-f",
        importContainerPath,
        recoveryContainerPath,
      ],
      { allowFailure: true },
    );
    throw error;
  }
  compose(["stop", "keycore-storefront", "keycore-admin"]);
  try {
    restoreContainerDump(env, importContainerPath);
    run("npm", ["run", "db:migrate"], { env });
    run("npm", ["run", "db:status"], { env });
    await startStack();
    await printStatus(env);
  } catch (error) {
    console.error(
      "Import fehlgeschlagen. Die lokale PostgreSQL-Datenbank wird aus dem Sicherheitsbackup wiederhergestellt.",
    );
    try {
      restoreContainerDump(env, recoveryContainerPath);
      await startStack();
    } catch (recoveryError) {
      throw new Error(
        `Import und automatische Recovery fehlgeschlagen. Writer bleiben gestoppt. Sicherheitsbackup: ${safety.dumpPath}. Ursache: ${recoveryError.message}`,
      );
    }
    throw new Error(
      `Import fehlgeschlagen; der vorherige Datenbankzustand wurde wiederhergestellt. Ursache: ${error.message}`,
    );
  } finally {
    compose(
      [
        "exec",
        "-T",
        "postgres",
        "rm",
        "-f",
        importContainerPath,
        recoveryContainerPath,
      ],
      { allowFailure: true },
    );
  }
  console.log(
    `PostgreSQL-Import abgeschlossen. Sicherheitsbackup bleibt erhalten: ${safety.dumpPath}`,
  );
};

const main = async () => {
  assertRepositoryRoot();
  if (command === "device") return configureDevice(commandArgs[0]);
  if (command === "work-start") return startWork(commandArgs[0]);
  if (command === "work-finish") return finishWork(commandArgs[0]);
  if (command === "db-export") return databaseExport(commandArgs[0]);
  if (command === "db-import") {
    const confirmationIndex = commandArgs.indexOf("--confirm");
    return databaseImport(
      commandArgs[0],
      confirmationIndex >= 0 ? commandArgs[confirmationIndex + 1] : undefined,
    );
  }
  if (command === "prerequisites") return assertPrerequisites();
  if (command === "setup") return setup();
  if (command === "start") {
    assertPrerequisites();
    await loadLocalEnv();
    await startStack();
    return printStatus();
  }
  if (command === "status") {
    assertDockerAvailable();
    return printStatus();
  }
  if (command === "logs") {
    assertDockerAvailable();
    await loadLocalEnv();
    return run("docker", logsArgs(commandArgs[0]));
  }
  if (command === "stop") {
    assertDockerAvailable();
    await loadLocalEnv();
    return run("docker", stopArgs());
  }
  if (command === "check") {
    assertPrerequisites();
    return check();
  }
  if (command === "handoff") return handoff();
  console.log(
    "Verwendung: npm run dev:{device|work-start|work-finish|db-export|db-import|setup|start|status|logs|check|stop|handoff|prerequisites}",
  );
};

main().catch((error) => {
  console.error(
    `FEHLER: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

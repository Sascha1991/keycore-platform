#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  COMPOSE_FILE,
  ENV_TEMPLATE_PATH,
  LOCAL_ENV_PATH,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_MAJOR,
  composeArgs,
  createLocalEnvValues,
  expectedServices,
  logsArgs,
  parseAheadBehind,
  parseComposePs,
  parseEnv,
  renderLocalEnv,
  serviceReadiness,
  stopArgs,
  toolchainReport,
  validateLocalEnv,
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

const main = async () => {
  assertRepositoryRoot();
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
    "Verwendung: npm run dev:{setup|start|status|logs|check|stop|handoff|prerequisites}",
  );
};

main().catch((error) => {
  console.error(
    `FEHLER: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

import { randomBytes } from "node:crypto";
import path from "node:path";

export const REQUIRED_NODE_VERSION = "22.22.0";
export const REQUIRED_NPM_MAJOR = 11;
export const LOCAL_ENV_PATH = "infra/docker/staging.local.env";
export const ENV_TEMPLATE_PATH = "infra/docker/staging.env.example";
export const COMPOSE_FILE = "infra/docker/compose.staging.yaml";
export const DEVICE_CONFIG_PATH = ".keycore-device.json";
export const IMPORT_CONFIRMATION = "DESTROY-LOCAL-POSTGRES";
export const LOG_TAIL = 200;
export const TRANSFER_FORMAT_VERSION = 1;
export const VALID_DEVICE_IDS = Object.freeze(["PC-1", "PC-2", "LAPTOP"]);

export const expectedServices = Object.freeze([
  "postgres",
  "redis",
  "mail",
  "wordpress-db",
  "keycore-storefront",
  "keycore-admin",
  "wordpress",
]);

export const logServiceAliases = Object.freeze({
  admin: "keycore-admin",
  mail: "mail",
  postgres: "postgres",
  redis: "redis",
  storefront: "keycore-storefront",
  wordpress: "wordpress",
  "wordpress-db": "wordpress-db",
});

export const parseEnv = (content) => {
  const result = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result[key] = value;
  }
  return result;
};

const token = (bytes, encoding = "base64url", random = randomBytes) =>
  random(bytes).toString(encoding);

export const createLocalEnvValues = (random = randomBytes) => {
  const deploymentId = "staging-local-dev";
  const postgresPassword = token(24, "base64url", random);
  const redisPassword = token(24, "base64url", random);
  return Object.freeze({
    KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL: "false",
    KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "false",
    KEYCORE_CSRF_ENABLED: "true",
    KEYCORE_DATABASE_URL: `postgres://keycore_staging:${postgresPassword}@127.0.0.1:15432/keycore_staging`,
    KEYCORE_DEBUG: "false",
    KEYCORE_DEPLOYMENT_ID: deploymentId,
    KEYCORE_ENCRYPTION_RESOURCE_ENV: "STAGING",
    KEYCORE_ENV: "STAGING",
    KEYCORE_FULFILLMENT_MASTER_KEY: token(32, "base64", random),
    KEYCORE_FULFILLMENT_MASTER_KEY_ID: "staging-local-fulfillment-v1",
    KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE: "",
    KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE: "",
    KEYCORE_MAIL_ALLOW_EXTERNAL: "false",
    KEYCORE_MAIL_HOST: "127.0.0.1",
    KEYCORE_MAIL_PORT: "11025",
    KEYCORE_OPERATIONS_AUTHORITY_MODE: "DISABLED",
    KEYCORE_POSTGRES_RESOURCE_ENV: "STAGING",
    KEYCORE_POSTGRES_RESOURCE_ID: "staging-postgres-local",
    KEYCORE_REDIS_NAMESPACE: `keycore:staging:${deploymentId}`,
    KEYCORE_REDIS_RESOURCE_ENV: "STAGING",
    KEYCORE_REDIS_RESOURCE_ID: "staging-redis-local",
    KEYCORE_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:16379`,
    KEYCORE_SECURE_COOKIES: "true",
    KEYCORE_STAGING_ADMIN_PORT: "18081",
    KEYCORE_STAGING_MAIL_MODE: "CAPTURE",
    KEYCORE_STAGING_MAIL_SMTP_PORT: "11025",
    KEYCORE_STAGING_MAIL_UI_PORT: "18025",
    KEYCORE_STAGING_POSTGRES_PASSWORD: postgresPassword,
    KEYCORE_STAGING_POSTGRES_PORT: "15432",
    KEYCORE_STAGING_PUBLIC_ORIGIN: "http://localhost:18080",
    KEYCORE_STAGING_REDIS_PASSWORD: redisPassword,
    KEYCORE_STAGING_REDIS_PORT: "16379",
    KEYCORE_STAGING_SUPPLIER_MODE: "MOCK",
    KEYCORE_STAGING_WORDPRESS_DB_PASSWORD: token(24, "base64url", random),
    KEYCORE_STAGING_WORDPRESS_PORT: "18080",
    KEYRANO_STAGING_ADMIN_CSRF_SECRET: token(48, "base64url", random),
    KEYRANO_STAGING_ADMIN_CURSOR_SECRET: token(48, "base64url", random),
    KEYRANO_STAGING_ADMIN_LOGIN_EMAIL: "admin@example.test",
    KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD: token(24, "base64url", random),
    KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE: "false",
    KEYRANO_STAGING_ADMIN_ORIGIN: "http://localhost:18081",
    KEYRANO_STAGING_ADMIN_PASSWORD: token(24, "base64url", random),
    KEYRANO_STAGING_ADMIN_ROLE: "PROJECT_OWNER",
    KEYRANO_STAGING_ADMIN_SECURE_COOKIES: "false",
    KEYRANO_STAGING_ADMIN_SESSION_CODE: token(48, "base64url", random),
    KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET: token(48, "base64url", random),
    KEYRANO_STAGING_ADMIN_UAT_SESSION_ENABLED: "false",
    KEYRANO_STAGING_ADMIN_USER: "keyrano-local-admin",
    KEYRANO_STAGING_BRIDGE_SECRET: token(48, "base64url", random),
    KEYRANO_STAGING_BROWSER_MASTER_KEY: token(32, "base64", random),
    KEYRANO_STAGING_CUSTOMER_A_PASSWORD: token(24, "base64url", random),
    KEYRANO_STAGING_CUSTOMER_A_WP_USER_ID: "2",
    KEYRANO_STAGING_CUSTOMER_B_PASSWORD: token(24, "base64url", random),
    KEYRANO_STAGING_CUSTOMER_B_WP_USER_ID: "3",
    KEYRANO_STAGING_FORCE_SSL_ADMIN: "false",
    KEYRANO_STAGING_GUEST_CHECKOUT_EMAIL: "guest-checkout@example.test",
    KEYRANO_STAGING_GUEST_CLAIM_CODE: `SYNTHETIC_${token(32, "hex", random)}`,
    KEYRANO_STAGING_ORIGIN: "http://localhost:18080",
    KEYRANO_STAGING_SYNTHETIC_KEY: `SYNTHETIC_${token(32, "hex", random)}`,
    KINGUIN_API_BASE_URL: "",
    KINGUIN_API_KEY: "",
    KINGUIN_ENVIRONMENT: "SANDBOX",
    STRIPE_ENVIRONMENT: "TEST",
    STRIPE_SECRET_KEY: `sk_test_${token(24, "hex", random)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${token(24, "hex", random)}`,
  });
};

export const renderLocalEnv = (template, values) => {
  const seen = new Set();
  const rendered = template.split(/\r?\n/u).map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!Object.hasOwn(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  const missingFromTemplate = Object.keys(values).filter(
    (key) => !seen.has(key),
  );
  if (missingFromTemplate.length > 0) {
    rendered.push("", "# Local development values required by tooling.");
    for (const key of missingFromTemplate.sort()) {
      rendered.push(`${key}=${values[key]}`);
    }
  }
  return `${rendered.join("\n").trimEnd()}\n`;
};

const requiredLocalKeys = Object.freeze([
  "KEYCORE_ENV",
  "KEYCORE_DEPLOYMENT_ID",
  "KEYCORE_STAGING_POSTGRES_PASSWORD",
  "KEYCORE_DATABASE_URL",
  "KEYCORE_STAGING_REDIS_PASSWORD",
  "KEYCORE_REDIS_URL",
  "KEYCORE_REDIS_NAMESPACE",
  "KEYCORE_STAGING_WORDPRESS_DB_PASSWORD",
  "KEYRANO_STAGING_BRIDGE_SECRET",
  "KEYRANO_STAGING_BROWSER_MASTER_KEY",
  "KEYRANO_STAGING_SYNTHETIC_KEY",
  "KEYRANO_STAGING_GUEST_CLAIM_CODE",
  "KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD",
  "KEYRANO_STAGING_ADMIN_SESSION_CODE",
  "KEYRANO_STAGING_ADMIN_SESSION_HASH_SECRET",
  "KEYRANO_STAGING_ADMIN_CURSOR_SECRET",
  "KEYRANO_STAGING_ADMIN_CSRF_SECRET",
  "KEYRANO_STAGING_CUSTOMER_A_PASSWORD",
  "KEYRANO_STAGING_CUSTOMER_B_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "KEYCORE_FULFILLMENT_MASTER_KEY",
]);

export const validateLocalEnv = (env, templateEnv = {}) => {
  const missing = requiredLocalKeys.filter((key) => !env[key]);
  const templateDrift = Object.keys(templateEnv).filter(
    (key) => !Object.hasOwn(env, key),
  );
  const placeholders = Object.entries(env)
    .filter(([, value]) => /replace-with|GENERATE_LOCALLY/u.test(value))
    .map(([key]) => key);
  const errors = [];
  if (env.KEYCORE_ENV !== "STAGING")
    errors.push("KEYCORE_ENV muss STAGING sein.");
  if (
    !/^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(env.KEYCORE_DEPLOYMENT_ID ?? "")
  ) {
    errors.push("KEYCORE_DEPLOYMENT_ID ist ungültig.");
  }
  const storefrontOrigin = `http://localhost:${env.KEYCORE_STAGING_WORDPRESS_PORT ?? "18080"}`;
  const adminOrigin = `http://localhost:${env.KEYCORE_STAGING_ADMIN_PORT ?? "18081"}`;
  if (env.KEYRANO_STAGING_ORIGIN !== storefrontOrigin) {
    errors.push(`KEYRANO_STAGING_ORIGIN muss lokal ${storefrontOrigin} sein.`);
  }
  if (env.KEYRANO_STAGING_ADMIN_ORIGIN !== adminOrigin) {
    errors.push(`KEYRANO_STAGING_ADMIN_ORIGIN muss lokal ${adminOrigin} sein.`);
  }
  if (env.KEYRANO_STAGING_ADMIN_LOGIN_PASSWORD_ROTATE !== "false") {
    errors.push(
      "Die normale lokale Admin-Passwortrotation muss deaktiviert sein.",
    );
  }
  return Object.freeze({ errors, missing, placeholders, templateDrift });
};

export const composeArgs = (...args) => [
  "compose",
  "--env-file",
  LOCAL_ENV_PATH,
  "-f",
  COMPOSE_FILE,
  ...args,
];

export const stopArgs = () => composeArgs("down");

export const logsArgs = (requestedService) => {
  const service = requestedService
    ? logServiceAliases[requestedService]
    : undefined;
  if (requestedService && !service) {
    throw new Error(`Unbekannter Dienst: ${requestedService}`);
  }
  return composeArgs(
    "logs",
    "--tail",
    String(LOG_TAIL),
    ...(service ? [service] : expectedServices),
  );
};

export const toolchainReport = ({ nodeVersion, npmVersion }) => {
  const normalizedNode = nodeVersion.replace(/^v/u, "");
  const npmMajor = Number.parseInt(npmVersion.split(".")[0] ?? "", 10);
  return Object.freeze({
    node: normalizedNode === REQUIRED_NODE_VERSION,
    nodeDetected: normalizedNode,
    npm: npmMajor === REQUIRED_NPM_MAJOR,
    npmDetected: npmVersion,
  });
};

export const parseComposePs = (output) => {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
};

export const serviceReadiness = (rows) =>
  expectedServices.map((service) => {
    const row = rows.find((candidate) => candidate.Service === service);
    const running = row?.State === "running";
    const health = row?.Health ?? "";
    return Object.freeze({
      health,
      ready: Boolean(running && (!health || health === "healthy")),
      service,
      state: row?.State ?? "missing",
    });
  });

export const parseAheadBehind = (value) => {
  const [behindRaw, aheadRaw] = value.trim().split(/\s+/u);
  return Object.freeze({
    ahead: Number.parseInt(aheadRaw ?? "0", 10),
    behind: Number.parseInt(behindRaw ?? "0", 10),
  });
};

export const normalizeDeviceId = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!VALID_DEVICE_IDS.includes(normalized)) {
    throw new Error(
      `Ungültige Geräte-ID. Erlaubt: ${VALID_DEVICE_IDS.join(", ")}.`,
    );
  }
  return normalized;
};

export const parseDeviceConfig = (content) => {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${DEVICE_CONFIG_PATH} enthält kein gültiges JSON.`);
  }
  if (parsed?.version !== 1) {
    throw new Error(`${DEVICE_CONFIG_PATH} verwendet eine unbekannte Version.`);
  }
  return Object.freeze({
    deviceId: normalizeDeviceId(parsed.deviceId),
    version: 1,
  });
};

export const assertRequestedDevice = (
  configuredDeviceId,
  requestedDeviceId,
) => {
  const configured = normalizeDeviceId(configuredDeviceId);
  const requested = normalizeDeviceId(requestedDeviceId);
  if (configured !== requested) {
    throw new Error(
      `Geräte-ID stimmt nicht überein: lokal ${configured}, angefordert ${requested}.`,
    );
  }
  return configured;
};

export const gitStartDecision = ({ ahead, behind, dirty, hasUpstream }) => {
  if (dirty) return "BLOCK_DIRTY";
  if (!hasUpstream) return "BLOCK_NO_UPSTREAM";
  if (ahead > 0 && behind > 0) return "BLOCK_DIVERGED";
  if (behind > 0) return "FAST_FORWARD";
  return "READY";
};

export const finishDecision = ({ ahead, behind, dirty, hasUpstream }) => {
  if (dirty) return "BLOCK_DIRTY";
  if (!hasUpstream) return "BLOCK_NO_UPSTREAM";
  if (ahead > 0) return "BLOCK_AHEAD";
  if (behind > 0) return "BLOCK_BEHIND";
  return "SAFE_TO_HANDOFF";
};

export const isPathInside = (parentPath, candidatePath) => {
  const pathApi =
    /^[A-Za-z]:[\\/]/u.test(parentPath) &&
    /^[A-Za-z]:[\\/]/u.test(candidatePath)
      ? path.win32
      : path;
  const relative = pathApi.relative(
    pathApi.resolve(parentPath),
    pathApi.resolve(candidatePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
};

export const transferSidecarPaths = (dumpPath) =>
  Object.freeze({
    checksumPath: `${dumpPath}.sha256`,
    manifestPath: `${dumpPath}.manifest.json`,
  });

export const parseChecksumFile = (content, expectedFileName) => {
  const match = /^([a-f0-9]{64})\s+\*?(.+)\s*$/iu.exec(content.trim());
  if (!match || match[2] !== expectedFileName) {
    throw new Error(
      "Die SHA-256-Datei ist ungültig oder gehört zu einem anderen Dump.",
    );
  }
  return match[1].toLowerCase();
};

export const createTransferManifest = ({
  branch,
  commit,
  createdAt,
  deviceId,
  dumpFile,
  migrationCount,
  migrationLatest,
  sha256,
}) =>
  Object.freeze({
    branch,
    commit,
    createdAt,
    deviceId: normalizeDeviceId(deviceId),
    dumpFile,
    format: "postgres-custom",
    formatVersion: TRANSFER_FORMAT_VERSION,
    migrationCount,
    migrationLatest,
    repository: "Sascha1991/keycore-platform",
    sha256,
  });

export const validateTransferManifest = ({
  actualSha256,
  dumpFile,
  manifest,
  sidecarSha256,
}) => {
  const errors = [];
  if (manifest?.formatVersion !== TRANSFER_FORMAT_VERSION)
    errors.push("MANIFEST_VERSION_UNSUPPORTED");
  if (manifest?.repository !== "Sascha1991/keycore-platform")
    errors.push("MANIFEST_REPOSITORY_MISMATCH");
  if (manifest?.format !== "postgres-custom")
    errors.push("MANIFEST_FORMAT_INVALID");
  if (manifest?.dumpFile !== dumpFile) errors.push("MANIFEST_DUMP_MISMATCH");
  if (!/^[a-f0-9]{40}$/u.test(manifest?.commit ?? ""))
    errors.push("MANIFEST_COMMIT_INVALID");
  if (manifest?.sha256 !== actualSha256) errors.push("MANIFEST_HASH_MISMATCH");
  if (sidecarSha256 !== actualSha256) errors.push("SIDECAR_HASH_MISMATCH");
  return Object.freeze(errors);
};

export const assertImportConfirmation = (value) => {
  if (value !== IMPORT_CONFIRMATION) {
    throw new Error(
      `Import nicht bestätigt. Erforderlich: --confirm ${IMPORT_CONFIRMATION}`,
    );
  }
};

export const transferSecretDependencies = Object.freeze({
  KEYCORE_FULFILLMENT_MASTER_KEY:
    "Nur erforderlich, wenn persistiertes Fulfillment-Material entschlüsselt werden muss.",
  KEYCORE_FULFILLMENT_MASTER_KEY_ID:
    "Nur erforderlich, wenn persistiertes Fulfillment-Material entschlüsselt werden muss.",
  KEYRANO_STAGING_GUEST_CLAIM_CODE:
    "Nur erforderlich, wenn das persistierte Guest-Claim-Fixture weiter genutzt werden soll.",
});

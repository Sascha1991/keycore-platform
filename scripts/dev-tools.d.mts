export const REQUIRED_NODE_VERSION: string;
export const REQUIRED_NPM_MAJOR: number;
export const LOCAL_ENV_PATH: string;
export const ENV_TEMPLATE_PATH: string;
export const COMPOSE_FILE: string;
export const DEVICE_CONFIG_PATH: string;
export const IMPORT_CONFIRMATION: string;
export const LOG_TAIL: number;
export const TRANSFER_FORMAT_VERSION: number;
export const VALID_DEVICE_IDS: readonly string[];
export const expectedServices: readonly string[];
export const logServiceAliases: Readonly<Record<string, string>>;
export function parseEnv(content: string): Record<string, string>;
export function createLocalEnvValues(
  random?: (size: number) => Buffer,
): Readonly<Record<string, string>>;
export function renderLocalEnv(
  template: string,
  values: Readonly<Record<string, string>>,
): string;
export function validateLocalEnv(
  env: Readonly<Record<string, string>>,
  templateEnv?: Readonly<Record<string, string>>,
): Readonly<{
  errors: readonly string[];
  missing: readonly string[];
  placeholders: readonly string[];
  templateDrift: readonly string[];
}>;
export function composeArgs(...args: string[]): string[];
export function stopArgs(): string[];
export function logsArgs(requestedService?: string): string[];
export function toolchainReport(input: {
  nodeVersion: string;
  npmVersion: string;
}): Readonly<{
  node: boolean;
  nodeDetected: string;
  npm: boolean;
  npmDetected: string;
}>;
export function parseComposePs(output: string): Array<Record<string, string>>;
export function serviceReadiness(
  rows: readonly Record<string, string>[],
): ReadonlyArray<
  Readonly<{
    health: string;
    ready: boolean;
    service: string;
    state: string;
  }>
>;
export function parseAheadBehind(value: string): Readonly<{
  ahead: number;
  behind: number;
}>;
export function normalizeDeviceId(value: unknown): string;
export function parseDeviceConfig(content: string): Readonly<{
  deviceId: string;
  version: 1;
}>;
export function assertRequestedDevice(
  configuredDeviceId: string,
  requestedDeviceId: string,
): string;
export function gitStartDecision(input: {
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
}): string;
export function finishDecision(input: {
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
}): string;
export function isPathInside(
  parentPath: string,
  candidatePath: string,
): boolean;
export function transferSidecarPaths(dumpPath: string): Readonly<{
  checksumPath: string;
  manifestPath: string;
}>;
export function parseChecksumFile(
  content: string,
  expectedFileName: string,
): string;
export function createTransferManifest(input: {
  branch: string;
  commit: string;
  createdAt: string;
  deviceId: string;
  dumpFile: string;
  migrationCount: number;
  migrationLatest: string;
  sha256: string;
}): Readonly<Record<string, unknown>>;
export function validateTransferManifest(input: {
  actualSha256: string;
  dumpFile: string;
  manifest: Readonly<Record<string, unknown>>;
  sidecarSha256: string;
}): readonly string[];
export function assertImportConfirmation(value: unknown): void;
export const transferSecretDependencies: Readonly<Record<string, string>>;

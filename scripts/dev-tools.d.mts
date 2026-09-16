export const REQUIRED_NODE_VERSION: string;
export const REQUIRED_NPM_MAJOR: number;
export const LOCAL_ENV_PATH: string;
export const ENV_TEMPLATE_PATH: string;
export const COMPOSE_FILE: string;
export const LOG_TAIL: number;
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

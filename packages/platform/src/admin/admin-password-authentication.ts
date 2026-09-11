import {
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
} from "../contracts.js";
import { hashAdminSession, validateAuditEvent } from "../contracts.js";

const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const saltBytes = 16;
const derivedKeyBytes = 64;
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const dummyPasswordHash =
  "scrypt$16384$8$1$00000000000000000000000000000000$526f25b37838c4c5f5f0f05ee91bbdcf9a227b14f51f1f86f77e906b13f26716350dba400bdebb484c221b322a23e449599f88292bdcec784fae03ff458b9f02";

export interface StoredAdminPasswordCredential {
  readonly adminId: string;
  readonly identityStatus: "ACTIVE" | "DISABLED";
  readonly passwordHash: string;
}

export interface AdminPasswordCredentialRepository {
  findByEmail(
    emailNormalized: string,
  ): Promise<StoredAdminPasswordCredential | null>;
  issueSession(input: {
    readonly adminId: string;
    readonly expiresAt: Date;
    readonly issuedAt: Date;
    readonly sessionHash: string;
  }): Promise<void>;
}

export interface AdminPasswordLoginResult {
  readonly authenticated: boolean;
  readonly rawSession?: string;
}

export interface AdminPasswordLoginPort {
  login(
    email: string,
    password: string,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminPasswordLoginResult>;
}

export class AdminPasswordAuthenticationService implements AdminPasswordLoginPort {
  public constructor(
    private readonly credentials: AdminPasswordCredentialRepository,
    private readonly audit: AuditEventPort,
    private readonly sessionHashSecret: string,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async login(
    email: string,
    password: string,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminPasswordLoginResult> {
    const emailNormalized = normalizeAdminEmail(email);
    const credential = emailNormalized
      ? await this.credentials.findByEmail(emailNormalized)
      : null;
    const passwordCandidate = validPasswordInput(password) ? password : "";
    const passwordValid = await verifyAdminPassword(
      passwordCandidate,
      credential?.passwordHash ?? dummyPasswordHash,
    );
    const authenticated =
      emailNormalized !== null &&
      passwordCandidate !== "" &&
      credential?.identityStatus === "ACTIVE" &&
      passwordValid;
    const at = this.now();

    if (!authenticated || !credential) {
      await this.auditLogin(
        credential?.adminId ?? "anonymous",
        requestCorrelationId,
        "DENIED",
        at,
      );
      return { authenticated: false };
    }

    const rawSession = randomBytes(32).toString("base64url");
    await this.credentials.issueSession({
      adminId: credential.adminId,
      expiresAt: new Date(at.getTime() + sessionLifetimeMs),
      issuedAt: at,
      sessionHash: hashAdminSession(rawSession, this.sessionHashSecret),
    });
    await this.auditLogin(
      credential.adminId,
      requestCorrelationId,
      "SUCCEEDED",
      at,
    );
    return { authenticated: true, rawSession };
  }

  private async auditLogin(
    actorId: string,
    requestCorrelationId: CorrelationId,
    outcome: AuditEvent["outcome"],
    timestampUtc: Date,
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: actorId, type: "ADMIN" },
        correlationId: requestCorrelationId,
        entity: { id: "admin-portal", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "AUTH_SECURITY_EVENT",
        metadata: { authenticationMethod: "PASSWORD" },
        outcome,
        reasonCode:
          outcome === "SUCCEEDED"
            ? "ADMIN_PASSWORD_AUTHENTICATED"
            : "ADMIN_PASSWORD_AUTHENTICATION_DENIED",
        timestampUtc,
        uuid: randomUUID(),
      }),
    );
  }
}

export const hashAdminPassword = async (password: string): Promise<string> => {
  if (!validPasswordInput(password)) throw new Error("ADMIN_PASSWORD_INVALID");
  const salt = randomBytes(saltBytes);
  const derived = await scrypt(password, salt, {
    N: scryptCost,
    p: scryptParallelization,
    r: scryptBlockSize,
  });
  return `scrypt$${scryptCost}$${scryptBlockSize}$${scryptParallelization}$${salt.toString("hex")}$${derived.toString("hex")}`;
};

export const verifyAdminPassword = async (
  password: string,
  encodedHash: string,
): Promise<boolean> => {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [cost, blockSize, parallelization] = parts.slice(1, 4).map(Number);
  const saltHex = parts[4] ?? "";
  const expectedHex = parts[5] ?? "";
  if (
    cost !== scryptCost ||
    blockSize !== scryptBlockSize ||
    parallelization !== scryptParallelization ||
    !/^[a-f0-9]{32}$/u.test(saltHex) ||
    !/^[a-f0-9]{128}$/u.test(expectedHex)
  )
    return false;
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), {
    N: cost,
    p: parallelization,
    r: blockSize,
  });
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
};

export const normalizeAdminEmail = (email: string): string | null => {
  const normalized = email.trim().toLowerCase();
  return normalized.length >= 3 &&
    normalized.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
    ? normalized
    : null;
};

const validPasswordInput = (password: string): boolean =>
  password.length >= 12 && password.length <= 256;

const scrypt = (
  password: string,
  salt: Buffer,
  options: { readonly N: number; readonly p: number; readonly r: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    nodeScrypt(password, salt, derivedKeyBytes, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

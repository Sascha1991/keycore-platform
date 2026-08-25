import type {
  CustomerAuthSession,
  CustomerAuthSessionRepository,
  CustomerId,
  CustomerIdentityBinding,
  CustomerIdentityProvider,
  KeyCoreCustomer,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCustomerAuthSessionRepository implements CustomerAuthSessionRepository {
  private readonly sessions = new Map<string, CustomerAuthSession>();
  private readonly sessionByHash = new Map<string, string>();

  public constructor(
    private readonly options: {
      readonly findCustomerById: (
        customerId: CustomerId,
      ) => Promise<KeyCoreCustomer | null>;
      readonly findIdentityBindingByProviderSubject: (input: {
        readonly provider: CustomerIdentityProvider;
        readonly providerSubject: string;
      }) => Promise<CustomerIdentityBinding | null>;
      readonly findIdentityBindingById: (
        id: string,
      ) => Promise<CustomerIdentityBinding | null>;
    },
  ) {}

  public findIdentityBindingByProviderSubject(input: {
    readonly provider: CustomerIdentityProvider;
    readonly providerSubject: string;
  }): Promise<CustomerIdentityBinding | null> {
    return this.options.findIdentityBindingByProviderSubject(input);
  }

  public findIdentityBindingById(input: {
    readonly identityBindingId: string;
  }): Promise<CustomerIdentityBinding | null> {
    return this.options.findIdentityBindingById(input.identityBindingId);
  }

  public findCustomerById(
    customerId: CustomerId,
  ): Promise<KeyCoreCustomer | null> {
    return this.options.findCustomerById(customerId);
  }

  public async createSession(input: {
    readonly session: CustomerAuthSession;
  }): Promise<
    | { readonly status: "CREATED"; readonly session: CustomerAuthSession }
    | { readonly status: "TOKEN_HASH_COLLISION" }
    | { readonly status: "CUSTOMER_NOT_FOUND" }
    | { readonly status: "IDENTITY_BINDING_NOT_FOUND" }
  > {
    if (!(await this.findCustomerById(input.session.customerId))) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }
    const binding = await this.findIdentityBindingById({
      identityBindingId: input.session.identityBindingId,
    });
    if (
      !binding ||
      binding.customerId !== input.session.customerId ||
      binding.provider !== input.session.provider
    ) {
      return { status: "IDENTITY_BINDING_NOT_FOUND" };
    }
    if (this.sessionByHash.has(input.session.sessionTokenHash)) {
      return { status: "TOKEN_HASH_COLLISION" };
    }
    this.sessions.set(input.session.id, input.session);
    this.sessionByHash.set(input.session.sessionTokenHash, input.session.id);
    return { session: input.session, status: "CREATED" };
  }

  public async findSessionByTokenHash(input: {
    readonly sessionTokenHash: string;
  }): Promise<CustomerAuthSession | null> {
    const id = this.sessionByHash.get(input.sessionTokenHash);
    const session = id ? (this.sessions.get(id) ?? null) : null;
    if (!session) {
      return null;
    }
    const binding = await this.options.findIdentityBindingById(
      session.identityBindingId,
    );
    if (binding && binding.customerId !== session.customerId) {
      return null;
    }
    return session;
  }

  public async touchSession(input: {
    readonly sessionId: string;
    readonly minLastSeenAt: Date;
    readonly now: Date;
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (
      !session ||
      session.lastSeenAt.getTime() > input.minLastSeenAt.getTime()
    ) {
      return;
    }
    this.sessions.set(input.sessionId, {
      ...session,
      lastSeenAt: input.now,
      recordVersion: session.recordVersion + 1,
    });
  }

  public async rotateSessionToken(input: {
    readonly sessionId: string;
    readonly expectedTokenHash: string;
    readonly nextTokenHash: string;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ROTATED"; readonly session: CustomerAuthSession }
    | { readonly status: "STALE_SESSION" }
    | { readonly status: "TOKEN_HASH_COLLISION" }
  > {
    const session = this.sessions.get(input.sessionId);
    if (
      !session ||
      session.sessionTokenHash !== input.expectedTokenHash ||
      session.revokedAt
    ) {
      return { status: "STALE_SESSION" };
    }
    if (this.sessionByHash.has(input.nextTokenHash)) {
      return { status: "TOKEN_HASH_COLLISION" };
    }
    this.sessionByHash.delete(session.sessionTokenHash);
    this.sessionByHash.set(input.nextTokenHash, input.sessionId);
    const rotated = {
      ...session,
      lastSeenAt: input.now,
      recordVersion: session.recordVersion + 1,
      sessionTokenHash: input.nextTokenHash,
    };
    this.sessions.set(input.sessionId, rotated);
    return { session: rotated, status: "ROTATED" };
  }

  public async revokeSessionById(input: {
    readonly sessionId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND"> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return "NOT_FOUND";
    }
    if (session.revokedAt) {
      return "ALREADY_REVOKED";
    }
    this.sessions.set(input.sessionId, {
      ...session,
      recordVersion: session.recordVersion + 1,
      revokedAt: input.now,
    });
    return "REVOKED";
  }

  public async revokeAllCustomerSessions(input: {
    readonly customerId: CustomerId;
    readonly now: Date;
  }): Promise<{ readonly revokedCount: number }> {
    let revokedCount = 0;
    for (const [id, session] of this.sessions) {
      if (session.customerId === input.customerId && !session.revokedAt) {
        revokedCount += 1;
        this.sessions.set(id, {
          ...session,
          recordVersion: session.recordVersion + 1,
          revokedAt: input.now,
        });
      }
    }
    return { revokedCount };
  }

  public async inspectSession(input: {
    readonly sessionId: string;
  }): Promise<CustomerAuthSession | null> {
    return this.sessions.get(input.sessionId) ?? null;
  }
}

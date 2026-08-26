import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, OrderId } from "../domain/identifiers.js";
import { orderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  activationInstructions,
  type ActivationPlatform,
  type CustomerAccountReadRepository,
} from "./customer-account.js";
import type { AuthenticatedCustomerPrincipal } from "./customer-order-identity.js";

export interface ActivationInstructionStep {
  readonly label: string;
  readonly body: string;
}

export interface CustomerActivationInstructionDocument {
  readonly status: "AVAILABLE" | "NOT_AVAILABLE";
  readonly platform: ActivationPlatform | "UNKNOWN";
  readonly instructionCode: string;
  readonly version: number;
  readonly title: string;
  readonly steps: readonly ActivationInstructionStep[];
  readonly helpUrl?: string;
}

export type CustomerActivationInstructionsFailureCode =
  "AUTHENTICATION_REQUIRED" | "RESOURCE_NOT_AVAILABLE";

export type CustomerActivationInstructionsResult =
  | {
      readonly status: "OK";
      readonly orderId: OrderId;
      readonly instructions: CustomerActivationInstructionDocument;
    }
  | {
      readonly status: "DENIED";
      readonly code: CustomerActivationInstructionsFailureCode;
    };

export interface ActivationInstructionRegistryEntry {
  readonly platform: ActivationPlatform;
  readonly instructionCode: string;
  readonly version: number;
  readonly title: string;
  readonly steps: readonly ActivationInstructionStep[];
  readonly helpUrl?: string;
}

export interface CustomerActivationInstructionsServiceOptions {
  readonly repository: CustomerAccountReadRepository;
  readonly registry?: readonly ActivationInstructionRegistryEntry[];
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class CustomerActivationInstructionsService {
  private readonly registry: ReadonlyMap<
    string,
    ActivationInstructionRegistryEntry
  >;
  private readonly environment: AuditEvent["environment"];
  private readonly now: () => Date;

  public constructor(
    private readonly options: CustomerActivationInstructionsServiceOptions,
  ) {
    this.registry = buildRegistry(
      options.registry ?? defaultActivationInstructionRegistry,
    );
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
  }

  public async getActivationInstructions(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
    readonly orderId: string;
  }): Promise<CustomerActivationInstructionsResult> {
    const principal = acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    if (!isSafeUuid(input.orderId)) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const requestedOrderId = orderId(input.orderId);
    const order = await this.options.repository.findOwnedOrderDetail({
      customerId: principal.customerId,
      orderId: requestedOrderId,
    });
    if (!order) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: requestedOrderId,
        eventType: "CUSTOMER_ACTIVATION_INSTRUCTIONS_DENIED",
        outcome: "DENIED",
        reasonCode: "RESOURCE_NOT_AVAILABLE",
      });
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const projected = activationInstructions(order.activation);
    const instructions =
      projected.status === "AVAILABLE"
        ? this.registry.get(
            registryKey(projected.platform, projected.instructionCode),
          )
        : undefined;
    const document = instructions
      ? documentFromEntry(instructions)
      : unavailableActivationInstructions;
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: order.orderId,
      eventType: "CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode:
        document.status === "AVAILABLE"
          ? "CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED"
          : "CUSTOMER_ACTIVATION_INSTRUCTIONS_NOT_AVAILABLE",
      metadata: {
        instructionCode: document.instructionCode,
        instructionStatus: document.status,
        orderId: order.orderId,
        platform: document.platform,
      },
    });
    return { instructions: document, orderId: order.orderId, status: "OK" };
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly customerId: string;
    readonly entityId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: input.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: "CUSTOMER_ACTIVATION_INSTRUCTIONS" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: {
        customerId: input.customerId,
        reasonCode: input.reasonCode,
        ...input.metadata,
      },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const defaultActivationInstructionRegistry: readonly ActivationInstructionRegistryEntry[] =
  [
    {
      instructionCode: "STEAM_ACTIVATION_CODE",
      platform: "STEAM",
      steps: [
        {
          body: "Open the Steam client and sign in to the Steam account that should receive the game.",
          label: "Open Steam",
        },
        {
          body: "Choose Add a Game, then Activate a Product on Steam.",
          label: "Start activation",
        },
        {
          body: "Enter the delivered product code exactly as shown in the secure customer account.",
          label: "Enter code",
        },
      ],
      title: "Steam activation",
      version: 1,
    },
  ];

export const unavailableActivationInstructions: CustomerActivationInstructionDocument =
  {
    instructionCode: "GENERIC_SAFE_ACTIVATION",
    platform: "UNKNOWN",
    status: "NOT_AVAILABLE",
    steps: [],
    title: "Activation instructions are not available yet.",
    version: 1,
  };

const documentFromEntry = (
  entry: ActivationInstructionRegistryEntry,
): CustomerActivationInstructionDocument => ({
  ...(entry.helpUrl ? { helpUrl: entry.helpUrl } : {}),
  instructionCode: entry.instructionCode,
  platform: entry.platform,
  status: "AVAILABLE",
  steps: entry.steps.map((step) => ({ body: step.body, label: step.label })),
  title: entry.title,
  version: entry.version,
});

const validateRegistryEntry = (
  entry: ActivationInstructionRegistryEntry,
): void => {
  if (
    !isSafeCode(entry.instructionCode) ||
    !Number.isSafeInteger(entry.version) ||
    entry.version <= 0 ||
    !isSafeText(entry.title, 120) ||
    entry.steps.length === 0 ||
    entry.steps.length > 12
  ) {
    throw new Error("Activation instruction registry entry is invalid");
  }
  for (const step of entry.steps) {
    if (!isSafeText(step.label, 48) || !isSafeText(step.body, 320)) {
      throw new Error("Activation instruction registry step is invalid");
    }
  }
  if (entry.helpUrl && !isTrustedHelpUrl(entry.helpUrl)) {
    throw new Error("Activation instruction help URL is invalid");
  }
};

const buildRegistry = (
  entries: readonly ActivationInstructionRegistryEntry[],
): ReadonlyMap<string, ActivationInstructionRegistryEntry> => {
  const registry = new Map<string, ActivationInstructionRegistryEntry>();
  for (const entry of entries) {
    validateRegistryEntry(entry);
    const key = registryKey(entry.platform, entry.instructionCode);
    if (registry.has(key)) {
      throw new Error("Activation instruction registry key is duplicated");
    }
    registry.set(key, immutableRegistryEntry(entry));
  }
  return registry;
};

const immutableRegistryEntry = (
  entry: ActivationInstructionRegistryEntry,
): ActivationInstructionRegistryEntry =>
  Object.freeze({
    ...(entry.helpUrl ? { helpUrl: entry.helpUrl } : {}),
    instructionCode: entry.instructionCode,
    platform: entry.platform,
    steps: Object.freeze(
      entry.steps.map((step) =>
        Object.freeze({ body: step.body, label: step.label }),
      ),
    ),
    title: entry.title,
    version: entry.version,
  });

const registryKey = (platform: string, instructionCode: string): string =>
  `${platform}:${instructionCode}`;

const acceptedPrincipal = (
  principal: AuthenticatedCustomerPrincipal | null,
): AuthenticatedCustomerPrincipal | null =>
  principal?.authenticationContext.assurance === "AUTHENTICATED"
    ? principal
    : null;

const isSafeUuid = (value: string): boolean => {
  const parts = value.split("-");
  return (
    parts.length === 5 &&
    /^[0-9a-f]{8}$/iu.test(parts[0] ?? "") &&
    /^[0-9a-f]{4}$/iu.test(parts[1] ?? "") &&
    /^[1-5][0-9a-f]{3}$/iu.test(parts[2] ?? "") &&
    /^[89ab][0-9a-f]{3}$/iu.test(parts[3] ?? "") &&
    /^[0-9a-f]{12}$/iu.test(parts[4] ?? "")
  );
};

const isSafeCode = (value: string): boolean => /^[A-Z0-9_]{1,80}$/u.test(value);

const isSafeText = (value: string, maxLength: number): boolean =>
  value.length > 0 &&
  value.length <= maxLength &&
  !/[<>\u0000-\u001f\u007f]/u.test(value);

const isTrustedHelpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      ["help.steampowered.com", "store.steampowered.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

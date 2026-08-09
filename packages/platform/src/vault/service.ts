import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  KeyRecordId,
  OrderLineId,
} from "../domain/identifiers.js";
import { correlationId, keyRecordId } from "../domain/identifiers.js";
import type {
  EncryptedKeyRepository,
  KeyManagementProvider,
} from "./crypto.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  decryptProductKeyMaterial,
  encryptProductKeyMaterial,
  rewrapDataEncryptionKey,
} from "./crypto.js";

export interface KeyAccessActor {
  readonly type: "CUSTOMER" | "ADMIN" | "SYSTEM";
  readonly id: string;
}

export interface KeyAccessContext {
  readonly actor: KeyAccessActor;
  readonly correlationId: CorrelationId;
  readonly customerId?: CustomerId;
  readonly orderLineId: OrderLineId;
  readonly reasonCode: string;
}

export interface KeyAccessAuthorization {
  readonly allowed: boolean;
  readonly reasonCode: string;
}

export interface KeyAccessAuthorizationPort {
  authorizeReveal(context: KeyAccessContext): Promise<KeyAccessAuthorization>;
}

export interface StoreProductKeyRequest {
  readonly actor?: KeyAccessActor;
  readonly correlationId: CorrelationId;
  readonly orderLineId: OrderLineId;
  readonly receivedSecretMaterial: Uint8Array;
}

export class ProductKeyVaultService {
  public constructor(
    private readonly repository: EncryptedKeyRepository,
    private readonly keyManagementProvider: KeyManagementProvider,
    private readonly authorization: KeyAccessAuthorizationPort,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
  ) {}

  public async storeReceivedKey(
    request: StoreProductKeyRequest,
  ): Promise<KeyRecordId> {
    const material = await encryptProductKeyMaterial(
      request.receivedSecretMaterial,
      { orderLineId: request.orderLineId },
      this.keyManagementProvider,
    );
    const record = await this.repository.store({
      material,
      orderLineId: request.orderLineId,
    });

    await this.auditKeyEvent({
      actor: request.actor ?? { id: "key-vault", type: "SYSTEM" },
      correlationId: request.correlationId,
      eventType: "KEY_STORED",
      keyVersion: record.keyVersion,
      orderLineId: request.orderLineId,
      outcome: "SUCCEEDED",
      reasonCode: "KEY_STORED",
      recordId: record.id,
    });

    return keyRecordId(record.id);
  }

  public async retrieveForAuthorizedReveal(
    context: KeyAccessContext,
  ): Promise<Uint8Array> {
    const decision = await this.authorization.authorizeReveal(context);
    const record = await this.repository.findActiveByOrderLineId(
      context.orderLineId,
    );

    if (!decision.allowed || !record) {
      await this.auditKeyEvent({
        actor: context.actor,
        correlationId: context.correlationId,
        eventType: "KEY_ACCESS_DENIED",
        keyVersion: record?.keyVersion ?? "unknown",
        orderLineId: context.orderLineId,
        outcome: "DENIED",
        reasonCode: decision.reasonCode,
        recordId: record?.id ?? "unknown",
      });
      throw new Error("Key reveal denied");
    }

    const revealed = await decryptProductKeyMaterial(
      record,
      { orderLineId: record.orderLineId },
      this.keyManagementProvider,
    );
    await this.auditKeyEvent({
      actor: context.actor,
      correlationId: context.correlationId,
      eventType: "KEY_REVEALED",
      keyVersion: record.keyVersion,
      orderLineId: context.orderLineId,
      outcome: "SUCCEEDED",
      reasonCode: context.reasonCode,
      recordId: record.id,
    });

    return revealed;
  }

  public async hasActiveKey(orderLineId: OrderLineId): Promise<boolean> {
    return (
      (await this.repository.findActiveByOrderLineId(orderLineId)) !== null
    );
  }

  public async getKeyVersionMetadata(
    keyRecordId: KeyRecordId,
  ): Promise<Readonly<Record<string, string>>> {
    const record = await this.repository.findById(keyRecordId);
    if (!record) {
      throw new Error("Encrypted key record not found");
    }

    return this.keyManagementProvider.getKeyVersionMetadata(record.keyVersion);
  }

  public async rotateKeyEncryptionMetadata(
    keyRecordId: KeyRecordId,
    newProvider: KeyManagementProvider = this.keyManagementProvider,
    now = new Date(),
  ): Promise<void> {
    const record = await this.repository.findById(keyRecordId);
    if (!record) {
      throw new Error("Encrypted key record not found");
    }

    const rewrapped = await rewrapDataEncryptionKey(
      record,
      this.keyManagementProvider,
      newProvider,
    );
    const updated = await this.repository.rewrap(record.id, {
      keyVersion: rewrapped.keyVersion,
      rotatedAt: now,
      wrappedDataEncryptionKey: rewrapped.wrappedDataEncryptionKey,
    });

    await this.auditKeyEvent({
      actor: { id: "key-vault", type: "SYSTEM" },
      correlationId: correlationId("system-key-rewrap"),
      eventType: "KEY_REWRAPPED",
      keyVersion: updated.keyVersion,
      orderLineId: updated.orderLineId,
      outcome: "SUCCEEDED",
      reasonCode: "KEY_REWRAPPED",
      recordId: updated.id,
    });
  }

  public async retireKey(
    keyRecordId: KeyRecordId,
    correlationId: CorrelationId,
  ): Promise<void> {
    const record = await this.repository.findById(keyRecordId);
    if (!record) {
      throw new Error("Encrypted key record not found");
    }

    await this.repository.retire(keyRecordId, new Date());
    await this.auditKeyEvent({
      actor: { id: "key-vault", type: "SYSTEM" },
      correlationId,
      eventType: "KEY_RETIRED",
      keyVersion: record.keyVersion,
      orderLineId: record.orderLineId,
      outcome: "SUCCEEDED",
      reasonCode: "KEY_RETIRED",
      recordId: keyRecordId,
    });
  }

  private async auditKeyEvent(request: {
    readonly actor: KeyAccessActor;
    readonly correlationId: CorrelationId;
    readonly eventType:
      | "KEY_ACCESS_DENIED"
      | "KEY_RETIRED"
      | "KEY_REVEALED"
      | "KEY_REWRAPPED"
      | "KEY_STORED";
    readonly keyVersion: string;
    readonly orderLineId: OrderLineId;
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly recordId: string;
  }): Promise<void> {
    await this.audit.append({
      actor: request.actor,
      correlationId: request.correlationId,
      entity: {
        id: request.recordId,
        type: "encrypted_key_record",
      },
      environment: this.environment,
      eventType: request.eventType,
      metadata: {
        keyVersion: request.keyVersion,
        orderLineId: request.orderLineId,
      },
      outcome: request.outcome,
      reasonCode: request.reasonCode,
      timestampUtc: new Date(),
      uuid: randomUUID(),
    });
  }
}

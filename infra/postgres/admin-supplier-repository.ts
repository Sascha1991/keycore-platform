import type {
  AdminMutationContext,
  AdminSupplierMutationRepository,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

export class PostgresAdminSupplierMutationRepository implements AdminSupplierMutationRepository {
  public constructor(private readonly database: TransactionalQueryable) {}

  public async create(
    input: Parameters<AdminSupplierMutationRepository["create"]>[0],
    context: AdminMutationContext,
  ): ReturnType<AdminSupplierMutationRepository["create"]> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<{
        readonly id: string;
        readonly display_name: string;
      }>(
        `SELECT id::text, display_name FROM suppliers WHERE supplier_code = $1 FOR UPDATE`,
        [input.supplierCode],
      );
      const row = existing.rows[0];
      if (row)
        return row.display_name === input.displayName
          ? { status: "IDEMPOTENT", supplierId: row.id }
          : { status: "CONFLICT" };

      await client.query(
        `INSERT INTO suppliers(id, supplier_code, display_name, capabilities, record_version, created_at, updated_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 1, $4, $4)`,
        [input.supplierId, input.supplierCode, input.displayName, context.at],
      );
      await appendSupplierAudit(
        client,
        context,
        input.supplierId,
        "ADMIN_SUPPLIER_CREATED",
        { providerType: input.providerType },
      );
      return { status: "CREATED", supplierId: input.supplierId };
    });
  }

  public async rename(
    input: Parameters<AdminSupplierMutationRepository["rename"]>[0],
    context: AdminMutationContext,
  ): ReturnType<AdminSupplierMutationRepository["rename"]> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        readonly display_name: string;
        readonly record_version: number;
      }>(
        `SELECT display_name, record_version FROM suppliers WHERE id = $1::uuid FOR UPDATE`,
        [input.supplierId],
      );
      const row = current.rows[0];
      if (!row) return "NOT_FOUND";
      if (row.record_version !== input.expectedVersion) return "STALE";
      if (row.display_name === input.displayName) return "UNCHANGED";
      await client.query(
        `UPDATE suppliers
         SET display_name = $2, record_version = record_version + 1, updated_at = $3
         WHERE id = $1::uuid`,
        [input.supplierId, input.displayName, context.at],
      );
      await appendSupplierAudit(
        client,
        context,
        input.supplierId,
        "ADMIN_SUPPLIER_RENAMED",
        {
          newDisplayName: input.displayName,
          previousDisplayName: row.display_name,
        },
      );
      return "UPDATED";
    });
  }
}

const appendSupplierAudit = async (
  client: Queryable,
  context: AdminMutationContext,
  supplierId: string,
  reasonCode: string,
  metadata: Readonly<Record<string, string>>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_events(id, event_type, timestamp_utc, actor, correlation_id, entity, environment, outcome, reason_code, metadata)
     VALUES (gen_random_uuid(), 'ADMIN_ACTION', $1, $2::jsonb, $3, $4::jsonb, $5, 'SUCCEEDED', $6, $7::jsonb)`,
    [
      context.at,
      JSON.stringify({ id: context.actorId, type: "ADMIN" }),
      context.correlationId,
      JSON.stringify({ id: supplierId, type: "SUPPLIER" }),
      context.environment,
      reasonCode,
      JSON.stringify({ action: reasonCode, ...metadata }),
    ],
  );
};

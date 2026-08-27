import {
  customerId,
  orderId,
  type CustomerId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type {
  CustomerSupportCaseDetail,
  OperatorSupportCaseDetail,
  SupportCase,
  SupportCaseEvent,
  SupportCaseLink,
  SupportCaseListPage,
  SupportCaseRepository,
  SupportCustomerReference,
  SupportLinkedReference,
  SupportMessage,
  SupportOrderReference,
} from "../../packages/platform/src/support/support-cases.js";
import { toCustomerDetail } from "../../packages/platform/src/support/support-cases.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface CaseRow {
  readonly id: string;
  readonly customer_id: string | null;
  readonly order_id: string | null;
  readonly category: SupportCase["category"];
  readonly status: SupportCase["status"];
  readonly priority: SupportCase["priority"];
  readonly source: SupportCase["source"];
  readonly resolution_code: SupportCase["resolutionCode"];
  readonly record_version: number;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly resolved_at: Date | null;
  readonly closed_at: Date | null;
}

interface MessageRow {
  readonly id: string;
  readonly case_id: string;
  readonly author_type: SupportMessage["authorType"];
  readonly visibility: SupportMessage["visibility"];
  readonly body: string;
  readonly created_at: Date;
}

interface EventRow {
  readonly id: string;
  readonly case_id: string;
  readonly event_type: SupportCaseEvent["eventType"];
  readonly actor_type: SupportCaseEvent["actorType"];
  readonly actor_reference: string;
  readonly from_status: SupportCaseEvent["fromStatus"];
  readonly to_status: SupportCaseEvent["toStatus"];
  readonly from_priority: SupportCaseEvent["fromPriority"];
  readonly to_priority: SupportCaseEvent["toPriority"];
  readonly link_type: SupportCaseEvent["linkType"];
  readonly link_target_id: string | null;
  readonly occurred_at: Date;
}

interface LinkRow {
  readonly id: string;
  readonly case_id: string;
  readonly link_type: SupportCaseLink["linkType"];
  readonly target_id: string;
  readonly order_id: string;
  readonly created_at: Date;
}

interface IdOrderRow {
  readonly id: string;
  readonly order_id: string;
}

interface CustomerRow {
  readonly id: string;
}

interface OrderRow {
  readonly id: string;
  readonly customer_id: string | null;
}

export class PostgresSupportCaseRepository implements SupportCaseRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async findCustomerById(
    requestedCustomerId: CustomerId,
  ): Promise<SupportCustomerReference | null> {
    const result = await this.db.query<CustomerRow>(
      "SELECT id::text FROM keycore_customers WHERE id = $1 LIMIT 1",
      [requestedCustomerId],
    );
    return result.rows[0]
      ? { customerId: customerId(result.rows[0].id) }
      : null;
  }

  public async findOrderForCustomer(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
  }): Promise<SupportOrderReference | null> {
    const result = await this.db.query<OrderRow>(
      `
        SELECT id::text, customer_id::text
        FROM keycore_orders
        WHERE id = $1 AND customer_id = $2
        LIMIT 1
      `,
      [input.orderId, input.customerId],
    );
    return result.rows[0] ? orderReferenceFromRow(result.rows[0]) : null;
  }

  public async findOrderById(
    requestedOrderId: OrderId,
  ): Promise<SupportOrderReference | null> {
    const result = await this.db.query<OrderRow>(
      "SELECT id::text, customer_id::text FROM keycore_orders WHERE id = $1 LIMIT 1",
      [requestedOrderId],
    );
    return result.rows[0] ? orderReferenceFromRow(result.rows[0]) : null;
  }

  public async createCase(input: {
    readonly supportCase: SupportCase;
    readonly initialMessage: SupportMessage;
    readonly event: SupportCaseEvent;
  }): Promise<OperatorSupportCaseDetail> {
    return this.db.transaction(async (client) => {
      await insertCase(client, input.supportCase);
      await insertMessage(client, input.initialMessage);
      await insertEvent(client, input.event);
      return requiredDetail(await loadDetail(client, input.supportCase.id));
    });
  }

  public async findCustomerCaseById(input: {
    readonly caseId: string;
    readonly customerId: CustomerId;
  }): Promise<CustomerSupportCaseDetail | null> {
    const detail = await loadDetail(this.db, input.caseId, input.customerId);
    return detail ? toCustomerDetail(detail) : null;
  }

  public async findCaseById(
    caseId: string,
  ): Promise<OperatorSupportCaseDetail | null> {
    return loadDetail(this.db, caseId);
  }

  public async listCustomerCases(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<SupportCaseListPage> {
    const values: unknown[] = [input.customerId];
    const cursor = decodeCursor(input.cursor);
    const cursorPredicate = cursor
      ? "AND (updated_at, id) < ($2, $3::uuid)"
      : "";
    if (cursor) {
      values.push(cursor.updatedAt, cursor.id);
    }
    values.push(input.limit + 1);
    const result = await this.db.query<CaseRow>(
      `
        SELECT ${caseColumns}
        FROM support_cases
        WHERE customer_id = $1
          ${cursorPredicate}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    const pageRows = result.rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(caseFromRow),
      nextCursor:
        result.rows.length > input.limit && last
          ? encodeCursor(last.updated_at, last.id)
          : null,
    };
  }

  public async addMessage(input: {
    readonly caseId: string;
    readonly customerId?: CustomerId;
    readonly message: SupportMessage;
    readonly event: SupportCaseEvent;
    readonly allowedStatuses: readonly SupportCase["status"][];
  }): Promise<
    | { readonly status: "ADDED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CLOSED_TO_REPLIES" }
  > {
    return this.db.transaction(async (client) => {
      const loaded = await lockCase(client, input.caseId, input.customerId);
      if (!loaded) {
        return { status: "RESOURCE_NOT_AVAILABLE" };
      }
      if (!input.allowedStatuses.includes(loaded.status)) {
        return { status: "CLOSED_TO_REPLIES" };
      }
      await insertMessage(client, input.message);
      await insertEvent(client, input.event);
      await client.query(
        `
          UPDATE support_cases
          SET updated_at = $2, record_version = record_version + 1
          WHERE id = $1
        `,
        [input.caseId, input.message.createdAt],
      );
      return {
        detail: requiredDetail(await loadDetail(client, input.caseId)),
        status: "ADDED",
      };
    });
  }

  public async transitionCase(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupportCase["status"];
    readonly resolutionCode: SupportCase["resolutionCode"];
    readonly now: Date;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  > {
    return this.db.transaction(async (client) => {
      const loaded = await lockCase(client, input.caseId);
      if (!loaded) {
        return { status: "RESOURCE_NOT_AVAILABLE" };
      }
      if (loaded.recordVersion !== input.expectedVersion) {
        return { status: "STALE_VERSION" };
      }
      await client.query(
        `
          UPDATE support_cases
          SET status = $2,
              resolution_code = $3,
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE resolved_at END,
              closed_at = CASE WHEN $2 = 'CLOSED' THEN $4 ELSE closed_at END,
              updated_at = $4,
              record_version = record_version + 1
          WHERE id = $1
        `,
        [input.caseId, input.nextStatus, input.resolutionCode, input.now],
      );
      await insertEvent(client, input.event);
      return {
        detail: requiredDetail(await loadDetail(client, input.caseId)),
        status: "UPDATED",
      };
    });
  }

  public async updatePriority(): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  > {
    return { status: "RESOURCE_NOT_AVAILABLE" };
  }

  public async findDisputeEvidence(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.findReference(
      "SELECT id::text, order_id::text FROM dispute_evidence_snapshots WHERE id = $1 LIMIT 1",
      id,
    );
  }

  public async findFraudReview(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.findReference(
      "SELECT id::text, order_id::text FROM fraud_manual_review_cases WHERE id = $1 LIMIT 1",
      id,
    );
  }

  public async findFraudEvaluation(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.findReference(
      "SELECT id::text, order_id::text FROM fraud_risk_evaluations WHERE id = $1 LIMIT 1",
      id,
    );
  }

  public async findFulfillment(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.findReference(
      "SELECT id::text, order_id::text FROM fulfillment_operations WHERE id = $1 LIMIT 1",
      id,
    );
  }

  public async linkReference(input: {
    readonly caseId: string;
    readonly link: SupportCaseLink;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "LINKED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CONFLICT" }
  > {
    return this.db.transaction(async (client) => {
      const loaded = await lockCase(client, input.caseId);
      if (!loaded || loaded.orderId !== input.link.orderId) {
        return { status: "RESOURCE_NOT_AVAILABLE" };
      }
      try {
        await insertLink(client, input.link);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { status: "CONFLICT" };
        }
        throw error;
      }
      await insertEvent(client, input.event);
      return {
        detail: requiredDetail(await loadDetail(client, input.caseId)),
        status: "LINKED",
      };
    });
  }

  private async findReference(
    sql: string,
    id: string,
  ): Promise<SupportLinkedReference | null> {
    const result = await this.db.query<IdOrderRow>(sql, [id]);
    return result.rows[0]
      ? { id: result.rows[0].id, orderId: orderId(result.rows[0].order_id) }
      : null;
  }
}

const caseColumns = `
  id::text,
  customer_id::text,
  order_id::text,
  category,
  status,
  priority,
  source,
  resolution_code,
  record_version,
  correlation_id,
  created_at,
  updated_at,
  resolved_at,
  closed_at
`;

const insertCase = async (
  client: Queryable,
  supportCase: SupportCase,
): Promise<void> => {
  await client.query(
    `
      INSERT INTO support_cases(
        id, customer_id, order_id, category, status, priority, source,
        resolution_code, record_version, correlation_id, created_at,
        updated_at, resolved_at, closed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `,
    [
      supportCase.id,
      supportCase.customerId,
      supportCase.orderId,
      supportCase.category,
      supportCase.status,
      supportCase.priority,
      supportCase.source,
      supportCase.resolutionCode,
      supportCase.recordVersion,
      supportCase.correlationId,
      supportCase.createdAt,
      supportCase.updatedAt,
      supportCase.resolvedAt,
      supportCase.closedAt,
    ],
  );
};

const insertMessage = async (
  client: Queryable,
  message: SupportMessage,
): Promise<void> => {
  await client.query(
    `
      INSERT INTO support_messages(
        id, case_id, author_type, visibility, body, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      message.id,
      message.caseId,
      message.authorType,
      message.visibility,
      message.body,
      message.createdAt,
    ],
  );
};

const insertEvent = async (
  client: Queryable,
  event: SupportCaseEvent,
): Promise<void> => {
  await client.query(
    `
      INSERT INTO support_case_events(
        id, case_id, event_type, actor_type, actor_reference, from_status,
        to_status, from_priority, to_priority, link_type, link_target_id,
        occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      event.id,
      event.caseId,
      event.eventType,
      event.actorType,
      event.actorReference,
      event.fromStatus,
      event.toStatus,
      event.fromPriority,
      event.toPriority,
      event.linkType,
      event.linkTargetId,
      event.occurredAt,
    ],
  );
};

const insertLink = async (
  client: Queryable,
  link: SupportCaseLink,
): Promise<void> => {
  await client.query(
    `
      INSERT INTO support_case_links(
        id, case_id, link_type, dispute_evidence_snapshot_id,
        fraud_review_case_id, fraud_evaluation_id, fulfillment_id,
        order_id, created_at
      )
      VALUES (
        $1, $2, $3,
        CASE WHEN $3 = 'DISPUTE_EVIDENCE' THEN $4::uuid ELSE NULL END,
        CASE WHEN $3 = 'FRAUD_REVIEW' THEN $4::uuid ELSE NULL END,
        CASE WHEN $3 = 'FRAUD_EVALUATION' THEN $4::uuid ELSE NULL END,
        CASE WHEN $3 = 'FULFILLMENT' THEN $4::uuid ELSE NULL END,
        $5, $6
      )
    `,
    [
      link.id,
      link.caseId,
      link.linkType,
      link.targetId,
      link.orderId,
      link.createdAt,
    ],
  );
};

const lockCase = async (
  client: Queryable,
  caseId: string,
  ownerCustomerId?: CustomerId,
): Promise<SupportCase | null> => {
  const values: unknown[] = [caseId];
  const ownerPredicate = ownerCustomerId ? "AND customer_id = $2" : "";
  if (ownerCustomerId) {
    values.push(ownerCustomerId);
  }
  const result = await client.query<CaseRow>(
    `
      SELECT ${caseColumns}
      FROM support_cases
      WHERE id = $1 ${ownerPredicate}
      FOR UPDATE
      LIMIT 1
    `,
    values,
  );
  return result.rows[0] ? caseFromRow(result.rows[0]) : null;
};

const loadDetail = async (
  client: Queryable,
  caseId: string,
  ownerCustomerId?: CustomerId,
): Promise<OperatorSupportCaseDetail | null> => {
  const values: unknown[] = [caseId];
  const ownerPredicate = ownerCustomerId ? "AND customer_id = $2" : "";
  if (ownerCustomerId) {
    values.push(ownerCustomerId);
  }
  const caseResult = await client.query<CaseRow>(
    `
      SELECT ${caseColumns}
      FROM support_cases
      WHERE id = $1 ${ownerPredicate}
      LIMIT 1
    `,
    values,
  );
  const supportCase = caseResult.rows[0]
    ? caseFromRow(caseResult.rows[0])
    : null;
  if (!supportCase) {
    return null;
  }
  const [messages, events, links] = await Promise.all([
    client.query<MessageRow>(
      `
        SELECT id::text, case_id::text, author_type, visibility, body, created_at
        FROM support_messages
        WHERE case_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [caseId],
    ),
    client.query<EventRow>(
      `
        SELECT
          id::text, case_id::text, event_type, actor_type, actor_reference,
          from_status, to_status, from_priority, to_priority, link_type,
          link_target_id::text, occurred_at
        FROM support_case_events
        WHERE case_id = $1
        ORDER BY occurred_at ASC, id ASC
      `,
      [caseId],
    ),
    client.query<LinkRow>(
      `
        SELECT
          id::text, case_id::text, link_type,
          COALESCE(
            dispute_evidence_snapshot_id::text,
            fraud_review_case_id::text,
            fraud_evaluation_id::text,
            fulfillment_id::text
          ) AS target_id,
          order_id::text,
          created_at
        FROM support_case_links
        WHERE case_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [caseId],
    ),
  ]);
  return {
    case: supportCase,
    events: events.rows.map(eventFromRow),
    links: links.rows.map(linkFromRow),
    messages: messages.rows.map(messageFromRow),
  };
};

const caseFromRow = (row: CaseRow): SupportCase => ({
  category: row.category,
  closedAt: row.closed_at,
  correlationId: row.correlation_id as SupportCase["correlationId"],
  createdAt: row.created_at,
  customerId: row.customer_id ? customerId(row.customer_id) : null,
  id: row.id,
  orderId: row.order_id ? orderId(row.order_id) : null,
  priority: row.priority,
  recordVersion: row.record_version,
  resolutionCode: row.resolution_code,
  resolvedAt: row.resolved_at,
  source: row.source,
  status: row.status,
  updatedAt: row.updated_at,
});

const messageFromRow = (row: MessageRow): SupportMessage => ({
  authorType: row.author_type,
  body: row.body,
  caseId: row.case_id,
  createdAt: row.created_at,
  id: row.id,
  visibility: row.visibility,
});

const eventFromRow = (row: EventRow): SupportCaseEvent => ({
  actorReference: row.actor_reference,
  actorType: row.actor_type,
  caseId: row.case_id,
  eventType: row.event_type,
  fromPriority: row.from_priority,
  fromStatus: row.from_status,
  id: row.id,
  linkTargetId: row.link_target_id,
  linkType: row.link_type,
  occurredAt: row.occurred_at,
  toPriority: row.to_priority,
  toStatus: row.to_status,
});

const linkFromRow = (row: LinkRow): SupportCaseLink => ({
  caseId: row.case_id,
  createdAt: row.created_at,
  id: row.id,
  linkType: row.link_type,
  orderId: orderId(row.order_id),
  targetId: row.target_id,
});

const orderReferenceFromRow = (row: OrderRow): SupportOrderReference => ({
  customerId: row.customer_id ? customerId(row.customer_id) : null,
  orderId: orderId(row.id),
});

const requiredDetail = (
  detail: OperatorSupportCaseDetail | null,
): OperatorSupportCaseDetail => {
  if (!detail) {
    throw new Error("Support case detail disappeared during transaction");
  }
  return detail;
};

const encodeCursor = (updatedAt: Date, id: string): string =>
  Buffer.from(
    JSON.stringify({ id, updatedAt: updatedAt.toISOString() }),
  ).toString("base64url");

const decodeCursor = (
  cursor: string | null,
): { readonly updatedAt: Date; readonly id: string } | null => {
  if (!cursor) {
    return null;
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { readonly updatedAt?: unknown; readonly id?: unknown } | null;
    if (typeof value?.updatedAt !== "string" || typeof value.id !== "string") {
      return null;
    }
    return { id: value.id, updatedAt: new Date(value.updatedAt) };
  } catch {
    return null;
  }
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "23505";

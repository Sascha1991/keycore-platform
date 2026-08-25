import type {
  CustomerAccountOrderProjection,
  CustomerAccountReadCursor,
  CustomerAccountReadRepository,
  CustomerAccountRecord,
  CustomerId,
  OrderId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCustomerAccountReadRepository implements CustomerAccountReadRepository {
  private readonly accounts = new Map<CustomerId, CustomerAccountRecord>();
  private readonly orders = new Map<OrderId, CustomerAccountOrderProjection>();

  public addAccount(account: CustomerAccountRecord): void {
    this.accounts.set(account.customerId, account);
  }

  public addOrder(order: CustomerAccountOrderProjection): void {
    this.orders.set(order.orderId, order);
  }

  public async findAccountSummary(
    customerId: CustomerId,
  ): Promise<CustomerAccountRecord | null> {
    return this.accounts.get(customerId) ?? null;
  }

  public async listOwnedOrders(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly after?: CustomerAccountReadCursor;
  }): Promise<{
    readonly orders: readonly CustomerAccountOrderProjection[];
    readonly nextCursor?: CustomerAccountReadCursor;
  }> {
    const sorted = [...this.orders.values()]
      .filter((order) => order.customerId === input.customerId)
      .sort(compareAccountOrders);
    const afterIndex = input.after
      ? sorted.findIndex(
          (order) =>
            order.createdAt.getTime() === input.after?.createdAt.getTime() &&
            order.orderId === input.after.orderId,
        )
      : -1;
    const start = input.after ? afterIndex + 1 : 0;
    const page = sorted.slice(start, start + input.limit);
    const hasMore = sorted.length > start + input.limit;
    const cursorOrder = page.at(-1);
    return {
      ...(hasMore && cursorOrder
        ? {
            nextCursor: {
              createdAt: cursorOrder.createdAt,
              orderId: cursorOrder.orderId,
            },
          }
        : {}),
      orders: page,
    };
  }

  public async findOwnedOrderDetail(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
  }): Promise<CustomerAccountOrderProjection | null> {
    const order = this.orders.get(input.orderId);
    return order?.customerId === input.customerId ? order : null;
  }
}

const compareAccountOrders = (
  left: CustomerAccountOrderProjection,
  right: CustomerAccountOrderProjection,
): number => {
  const byCreated = right.createdAt.getTime() - left.createdAt.getTime();
  return byCreated === 0
    ? right.orderId.localeCompare(left.orderId)
    : byCreated;
};

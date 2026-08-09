import type {
  SupplierErrorCategory,
  SupplierErrorContext,
} from "../ports/supplier.js";

const unsafeMessagePattern =
  /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|product[_-]?key|payment[_-]?credential)/iu;

export class SupplierError extends Error {
  public readonly category: SupplierErrorCategory;
  public readonly context: SupplierErrorContext;

  public constructor(context: SupplierErrorContext, message?: string) {
    const safeMessage =
      message && !unsafeMessagePattern.test(message)
        ? message
        : `Supplier ${context.operation} failed with ${context.category}`;
    super(safeMessage);
    this.name = "SupplierError";
    this.category = context.category;
    this.context = context;
  }
}

export const assertSupplierCapability = (
  supported: boolean,
  context: SupplierErrorContext,
): void => {
  if (!supported) {
    throw new SupplierError({
      ...context,
      category: "UNSUPPORTED_CAPABILITY",
    });
  }
};

export const assertSafeSupplierError = (error: unknown): void => {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  if (unsafeMessagePattern.test(serialized)) {
    throw new Error("Supplier error contains unsafe secret-like content");
  }
};

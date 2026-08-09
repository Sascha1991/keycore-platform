export type ErrorClassification = "RETRYABLE" | "NON_RETRYABLE";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  baseDelayMs: 1_000,
  jitterRatio: 0.1,
  maxAttempts: 5,
  maxDelayMs: 60_000,
};

export const classifyError = (error: unknown): ErrorClassification => {
  if (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === false
  ) {
    return "NON_RETRYABLE";
  }

  return "RETRYABLE";
};

export const nextRetryDelayMs = (
  attempt: number,
  policy: RetryPolicy = defaultRetryPolicy,
): number => {
  if (attempt < 1) {
    throw new Error("Attempt must be at least 1");
  }

  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const deterministicJitter = Math.floor(capped * policy.jitterRatio);
  return Math.min(capped + deterministicJitter, policy.maxDelayMs);
};

export const shouldRetry = (
  attempt: number,
  classification: ErrorClassification,
  policy: RetryPolicy = defaultRetryPolicy,
): boolean => classification === "RETRYABLE" && attempt < policy.maxAttempts;

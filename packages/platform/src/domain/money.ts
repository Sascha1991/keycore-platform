import { brandString, type Brand } from "./brands.js";

export type Currency = Brand<string, "Currency">;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

const currencyPattern = /^[A-Z]{3}$/;

export const currency = (value: string): Currency => {
  if (!currencyPattern.test(value)) {
    throw new Error("Currency must be an ISO-like three-letter uppercase code");
  }

  return brandString(value, "Currency");
};

export const money = (amountMinor: bigint, moneyCurrency: Currency): Money => {
  if (amountMinor < 0n) {
    throw new Error("Money amount must not be negative");
  }

  return {
    amountMinor,
    currency: moneyCurrency,
  };
};

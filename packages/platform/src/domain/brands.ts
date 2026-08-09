export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export const brandString = <TBrand extends string>(
  value: string,
  brandName: TBrand,
): Brand<string, TBrand> => {
  if (value.trim().length === 0) {
    throw new Error(`${brandName} must not be empty`);
  }

  return value as Brand<string, TBrand>;
};

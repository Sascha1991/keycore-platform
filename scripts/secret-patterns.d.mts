export interface SecretCheck {
  readonly name: string;
  readonly pattern: RegExp;
}

export const secretChecks: readonly SecretCheck[];

export const scanSecretText: (content: string) => readonly string[];

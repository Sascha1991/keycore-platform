export type StagingCatalogEligibility =
  "ALLOWED" | "BLOCKED" | "REVIEW_REQUIRED";

export interface StagingCatalogProduct {
  readonly productId: string;
  readonly publicReference: string;
  readonly title: string;
  readonly platform: string;
  readonly region: string;
  readonly activation: string;
  readonly description: string;
  readonly priceMinor: number;
  readonly currency: "EUR";
  readonly availability: "IN_STOCK" | "UNAVAILABLE";
  readonly eligibility: StagingCatalogEligibility;
}

export const stagingCatalog: readonly StagingCatalogProduct[] = [
  {
    activation: "Steam",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Synthetisches Abenteuerspiel für den sicheren Staging-Test.",
    eligibility: "ALLOWED",
    platform: "PC",
    priceMinor: 1299,
    productId: "00000000-0000-4000-8000-000000120101",
    publicReference: "synthetic-de-adventure",
    region: "Deutschland",
    title: "Neonpfad: Berlin",
  },
  {
    activation: "Steam",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Global kompatibles synthetisches Strategiespiel.",
    eligibility: "ALLOWED",
    platform: "PC",
    priceMinor: 1899,
    productId: "00000000-0000-4000-8000-000000120102",
    publicReference: "synthetic-global-strategy",
    region: "Global",
    title: "Orbital Tactics",
  },
  {
    activation: "Epic Games",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Synthetisches Rennspiel für EU-kompatible Konten.",
    eligibility: "ALLOWED",
    platform: "PC",
    priceMinor: 999,
    productId: "00000000-0000-4000-8000-000000120103",
    publicReference: "synthetic-eu-racing",
    region: "EU",
    title: "Velocity Circuit",
  },
  {
    activation: "Steam",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Synthetisches Koop-Spiel für den Storefront-Test.",
    eligibility: "ALLOWED",
    platform: "PC",
    priceMinor: 1499,
    productId: "00000000-0000-4000-8000-000000120104",
    publicReference: "synthetic-de-coop",
    region: "Deutschland",
    title: "Signal Brigade",
  },
  {
    activation: "Xbox",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Synthetisches Sportspiel für Deutschland.",
    eligibility: "ALLOWED",
    platform: "Xbox",
    priceMinor: 2199,
    productId: "00000000-0000-4000-8000-000000120105",
    publicReference: "synthetic-de-sports",
    region: "Deutschland",
    title: "Arena Eleven",
  },
  {
    activation: "PlayStation",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Synthetisches Puzzle-Spiel mit globaler Aktivierung.",
    eligibility: "ALLOWED",
    platform: "PlayStation",
    priceMinor: 799,
    productId: "00000000-0000-4000-8000-000000120106",
    publicReference: "synthetic-global-puzzle",
    region: "Global",
    title: "Lumen Grid",
  },
  {
    activation: "Nicht verfügbar",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Nur negative Staging-Fixture.",
    eligibility: "BLOCKED",
    platform: "PC",
    priceMinor: 1099,
    productId: "00000000-0000-4000-8000-000000120107",
    publicReference: "synthetic-region-blocked",
    region: "Nicht DE-kompatibel",
    title: "Blocked Region Fixture",
  },
  {
    activation: "Nicht verfügbar",
    availability: "IN_STOCK",
    currency: "EUR",
    description: "Nur negative Staging-Fixture.",
    eligibility: "REVIEW_REQUIRED",
    platform: "PC",
    priceMinor: 1199,
    productId: "00000000-0000-4000-8000-000000120108",
    publicReference: "synthetic-region-review",
    region: "Unbekannt",
    title: "Review Required Fixture",
  },
  {
    activation: "Steam",
    availability: "UNAVAILABLE",
    currency: "EUR",
    description: "Nur negative Staging-Fixture.",
    eligibility: "ALLOWED",
    platform: "PC",
    priceMinor: 1599,
    productId: "00000000-0000-4000-8000-000000120109",
    publicReference: "synthetic-unavailable",
    region: "Deutschland",
    title: "Unavailable Fixture",
  },
] as const;

export const publishableStagingCatalog = (): readonly StagingCatalogProduct[] =>
  stagingCatalog.filter(
    (product) =>
      product.eligibility === "ALLOWED" &&
      product.availability === "IN_STOCK" &&
      product.priceMinor > 0,
  );

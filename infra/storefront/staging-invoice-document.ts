import type {
  CustomerInvoiceDocumentProvider,
  CustomerId,
  OrderId,
} from "../../packages/platform/src/contracts.js";

export interface SyntheticStagingInvoiceFixture {
  readonly customerId: CustomerId;
  readonly orderId: OrderId;
  readonly invoiceReference: string;
  readonly issuedAt: string;
  readonly productTitle: string;
  readonly currency: string;
  readonly totalMinor: string;
}

export class SyntheticStagingInvoiceDocumentProvider implements CustomerInvoiceDocumentProvider {
  public constructor(
    private readonly fixture: SyntheticStagingInvoiceFixture,
  ) {}

  public async getDocument(
    input: SyntheticStagingInvoiceFixture,
  ): ReturnType<CustomerInvoiceDocumentProvider["getDocument"]> {
    if (!sameFixture(input, this.fixture)) {
      return { status: "NOT_AVAILABLE" };
    }
    return {
      bytes: renderSyntheticPdf(input),
      contentType: "application/pdf",
      status: "AVAILABLE",
    };
  }
}

const sameFixture = (
  left: SyntheticStagingInvoiceFixture,
  right: SyntheticStagingInvoiceFixture,
): boolean =>
  left.customerId === right.customerId &&
  left.orderId === right.orderId &&
  left.invoiceReference === right.invoiceReference &&
  left.issuedAt === right.issuedAt &&
  left.productTitle === right.productTitle &&
  left.currency === right.currency &&
  left.totalMinor === right.totalMinor;

const renderSyntheticPdf = (
  invoice: SyntheticStagingInvoiceFixture,
): Uint8Array => {
  const lines = [
    "KeyRaNo - Synthetische Staging-Rechnung",
    "Nicht rechtsgueltig. Nur fuer isolierte Human-UAT.",
    `Referenz: ${invoice.invoiceReference}`,
    `Datum: ${invoice.issuedAt.slice(0, 10)}`,
    `Produkt: ${invoice.productTitle}`,
    `Summe: ${formatMinor(invoice.totalMinor)} ${invoice.currency}`,
  ];
  const stream = [
    "BT",
    "/F1 14 Tf",
    "50 790 Td",
    ...lines.flatMap((line, index) => [
      index === 0 ? "" : "0 -28 Td",
      `(${escapePdfText(line)}) Tj`,
    ]),
    "ET",
  ]
    .filter(Boolean)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
};

const escapePdfText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/gu, "")
    .replace(/[\\()]/gu, "\\$&");

const formatMinor = (value: string): string => {
  const amount = BigInt(value);
  const whole = amount / 100n;
  const minor = (amount % 100n).toString().padStart(2, "0");
  return `${whole}.${minor}`;
};

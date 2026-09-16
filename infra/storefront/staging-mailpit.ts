import type {
  AdminPasswordResetDeliveryPort,
  CorrelationId,
  GuestOrderClaimDeliveryPort,
  OrderId,
} from "../../packages/platform/src/contracts.js";

export interface StagingReadinessNotificationPort {
  sendReady(input: {
    readonly emailNormalized: string;
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" | "FAILED" }>;
}

export class MailpitStagingTransport
  implements
    AdminPasswordResetDeliveryPort,
    GuestOrderClaimDeliveryPort,
    StagingReadinessNotificationPort
{
  private readonly endpoint: string;
  private readonly adminOrigin: string;

  public constructor(baseUrl: string, adminOrigin = "http://127.0.0.1:18081") {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "mail" ||
      parsed.port !== "8025" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Internal staging Mailpit URL is required");
    }
    this.endpoint = `${parsed.origin}/api/v1/send`;
    const parsedAdminOrigin = new URL(adminOrigin);
    const localHttp =
      parsedAdminOrigin.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(parsedAdminOrigin.hostname);
    if (
      (!localHttp && parsedAdminOrigin.protocol !== "https:") ||
      parsedAdminOrigin.username ||
      parsedAdminOrigin.password ||
      parsedAdminOrigin.pathname !== "/" ||
      parsedAdminOrigin.search ||
      parsedAdminOrigin.hash
    ) {
      throw new Error("Admin staging origin is required");
    }
    this.adminOrigin = parsedAdminOrigin.origin;
  }

  public async sendPasswordReset(input: {
    readonly emailNormalized: string;
    readonly expiresAt: Date;
    readonly rawToken: string;
  }): Promise<{ readonly status: "ACCEPTED" | "FAILED" }> {
    return this.send(
      input.emailNormalized,
      "KeyRaNo Admin-Passwort zurücksetzen",
      [
        "Für Ihr KeyRaNo Admin-Konto wurde eine Passwortänderung angefordert.",
        `Einmaliger Link: ${this.adminOrigin}/admin/password-reset/${encodeURIComponent(input.rawToken)}`,
        `Gültig bis: ${input.expiresAt.toISOString()}`,
        "Falls Sie diese Änderung nicht angefordert haben, ignorieren Sie diese Nachricht.",
      ].join("\n\n"),
    );
  }

  public async sendGuestOrderClaim(input: {
    readonly orderId: OrderId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawClaimCode: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" | "FAILED" }> {
    if (!isSyntheticRecipient(input.emailNormalized)) {
      return { status: "FAILED" };
    }
    return this.send(
      input.emailNormalized,
      "Dein KeyRaNo Kauf kann hinzugefügt werden",
      [
        "Deine synthetische Staging-Bestellung wurde bezahlt.",
        "Erstelle oder verwende ein KeyRaNo-Konto mit exakt derselben E-Mail-Adresse.",
        `Einmaliger Kauf-Code: ${input.rawClaimCode}`,
        `Gültig bis: ${input.expiresAt.toISOString()}`,
        "Dieser Code ist kein Produktschlüssel.",
      ].join("\n\n"),
    );
  }

  public async sendReady(input: {
    readonly emailNormalized: string;
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" | "FAILED" }> {
    if (!isSyntheticRecipient(input.emailNormalized)) {
      return { status: "FAILED" };
    }
    return this.send(
      input.emailNormalized,
      "Dein synthetischer KeyRaNo Kauf ist bereit",
      "Dein Kauf ist jetzt in deinem KeyRaNo-Konto bereit. Melde dich an und öffne „Meine Käufe“. Diese Nachricht enthält keinen Produktschlüssel.",
    );
  }

  private async send(
    recipient: string,
    subject: string,
    body: string,
  ): Promise<{ readonly status: "ACCEPTED" | "FAILED" }> {
    try {
      const response = await fetch(this.endpoint, {
        body: JSON.stringify({
          From: { Email: "staging@keyrano.example.test", Name: "KeyRaNo" },
          Subject: subject,
          Text: body,
          To: [{ Email: recipient }],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(3_000),
      });
      return { status: response.ok ? "ACCEPTED" : "FAILED" };
    } catch {
      return { status: "FAILED" };
    }
  }
}

export const isSyntheticRecipient = (email: string): boolean =>
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)*example\.test$/u.test(email);

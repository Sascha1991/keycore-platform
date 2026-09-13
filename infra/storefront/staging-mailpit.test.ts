import { afterEach, describe, expect, it, vi } from "vitest";

import {
  correlationId,
  orderId,
} from "../../packages/platform/src/contracts.js";
import {
  MailpitStagingTransport,
  isSyntheticRecipient,
} from "./staging-mailpit.js";

describe("MailpitStagingTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delivers a guest claim only to the internal capture sink and synthetic recipient", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const transport = new MailpitStagingTransport("http://mail:8025");
    const rawClaimCode = "SYNTHETIC_RUNTIME_CLAIM_1234567890";
    await expect(
      transport.sendGuestOrderClaim({
        challengeId: "challenge-id",
        correlationId: correlationId("mailpit-claim"),
        emailNormalized: "guest-checkout@example.test",
        expiresAt: new Date("2026-09-09T12:00:00.000Z"),
        orderId: orderId("20000000-0000-4000-8000-000000000099"),
        rawClaimCode,
      }),
    ).resolves.toEqual({ status: "ACCEPTED" });
    expect(fetch).toHaveBeenCalledWith(
      "http://mail:8025/api/v1/send",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.stringify(fetch.mock.calls)).toContain(rawClaimCode);
  });

  it("keeps readiness mail status-only and rejects external recipients and endpoints", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const transport = new MailpitStagingTransport("http://mail:8025");
    await transport.sendReady({
      correlationId: correlationId("mailpit-ready"),
      emailNormalized: "customer-a@example.test",
      orderId: orderId("20000000-0000-4000-8000-000000000099"),
    });
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(
      /SYNTHETIC_[A-Z0-9_-]{10,}|product.?key\s*[:=]/iu,
    );
    expect(isSyntheticRecipient("person@example.com")).toBe(false);
    await expect(
      transport.sendReady({
        correlationId: correlationId("mailpit-denied"),
        emailNormalized: "person@example.com",
        orderId: orderId("20000000-0000-4000-8000-000000000099"),
      }),
    ).resolves.toEqual({ status: "FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      () => new MailpitStagingTransport("https://mail.example.test"),
    ).toThrow("Internal staging Mailpit URL is required");
  });

  it("delivers a one-time Admin reset link through the internal Mailpit API", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const transport = new MailpitStagingTransport(
      "http://mail:8025",
      "https://admin.staging.keyrano.de",
    );
    const rawToken = "r".repeat(43);
    await expect(
      transport.sendPasswordReset({
        emailNormalized: "staff@example.test",
        expiresAt: new Date("2026-09-12T12:45:00.000Z"),
        rawToken,
      }),
    ).resolves.toEqual({ status: "ACCEPTED" });
    const payload = JSON.stringify(fetch.mock.calls);
    expect(payload).toContain(
      `https://admin.staging.keyrano.de/admin/password-reset/${rawToken}`,
    );
    expect(payload).toContain("2026-09-12T12:45:00.000Z");
    expect(payload).not.toMatch(/password_hash|session_code/iu);
  });
});

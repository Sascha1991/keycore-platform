import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync("infra/docker/compose.staging.yaml", "utf8");
const dockerfile = readFileSync(
  "infra/docker/Dockerfile.staging-storefront",
  "utf8",
);

const serviceBlock = (service: string): string => {
  const match = new RegExp(
    `^  ${service}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|^volumes:)`,
    "mu",
  ).exec(compose);
  if (!match) throw new Error(`Missing Compose service: ${service}`);
  return match[0];
};

describe("staging Admin Compose wiring", () => {
  it("keeps the Storefront image default bound to the Storefront server", () => {
    expect(dockerfile).toContain(
      'CMD ["node", "--import", "tsx", "scripts/staging-storefront-server.ts"]',
    );
    expect(serviceBlock("keycore-storefront")).not.toContain("command:");
  });

  it("starts the Admin server explicitly without borrowing the Storefront origin", () => {
    const admin = serviceBlock("keycore-admin");
    expect(admin).toContain(
      'command: ["node", "--import", "tsx", "scripts/staging-admin-server.ts"]',
    );
    expect(admin).not.toContain("KEYRANO_STAGING_ORIGIN:");
  });

  it("preserves the separate Admin bootstrap command", () => {
    expect(serviceBlock("keycore-admin-bootstrap")).toContain(
      'command: ["node", "--import", "tsx", "scripts/staging-admin-bootstrap.ts"]',
    );
  });
});

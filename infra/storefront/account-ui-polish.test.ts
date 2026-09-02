import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const cssPath = "apps/wordpress/keycore-platform/assets/keyrano.css";
const ordersTemplatePath =
  "apps/wordpress/keycore-platform/templates/account-orders.php";

describe("KeyRaNo account purchase presentation", () => {
  it("keeps purchase status pills dark and readable inside the account UI", async () => {
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(
      "body.woocommerce-account .keyrano-orders-page .keyrano-purchase__meta .keyrano-badge",
    );
    expect(css).toContain(
      "body.woocommerce-account .keyrano-order-detail .keyrano-order-summary .keyrano-badge",
    );
    expect(css).toMatch(
      /\.keyrano-order-summary \.keyrano-badge \{[\s\S]*?background: #24202f;[\s\S]*?border-color: #6d5a8f;[\s\S]*?color: #f7f5ff;[\s\S]*?\}/u,
    );
  });

  it("renders an account-scoped dark empty-purchase panel", async () => {
    const [css, template] = await Promise.all([
      readFile(cssPath, "utf8"),
      readFile(ordersTemplatePath, "utf8"),
    ]);

    expect(template).toContain("keyrano-state keyrano-empty-state");
    expect(template).toContain("Noch keine Käufe vorhanden.");
    expect(css).toMatch(
      /\.keyrano-account-surface \.keyrano-empty-state \{[\s\S]*?background: #15131c;[\s\S]*?border-left: 4px solid #8b5cf6;[\s\S]*?border-radius: 16px;[\s\S]*?color: #c9c3d6;[\s\S]*?grid-template-columns: 20px minmax\(0, 1fr\);[\s\S]*?\}/u,
    );
    expect(css).toContain(
      "body.woocommerce-account .keyrano-account-surface .keyrano-empty-state::before",
    );
  });
});

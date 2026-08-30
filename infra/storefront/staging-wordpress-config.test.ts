import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync("infra/docker/compose.staging.yaml", "utf8");
const exampleEnvironment = readFileSync(
  "infra/docker/staging.env.example",
  "utf8",
);

describe("staging WordPress configuration", () => {
  it("runs WP-CLI with the WordPress volume owner while preserving the read-only plugin mount", () => {
    expect(compose).toContain('user: "33:33"');
    expect(compose).toContain(
      "../../apps/wordpress/keycore-platform:/var/www/html/wp-content/plugins/keycore-platform:ro",
    );
    expect(compose).not.toContain("chmod 777");
  });

  it("defaults admin transport to HTTPS and permits only an explicit boolean override", () => {
    expect(compose).toContain(
      "KEYRANO_STAGING_FORCE_SSL_ADMIN: ${KEYRANO_STAGING_FORCE_SSL_ADMIN:-true}",
    );
    expect(compose).toContain(
      "in_array($$keyrano_force_ssl_admin, ['true', 'false'], true)",
    );
    expect(compose).toContain(
      "define('FORCE_SSL_ADMIN', 'true' === $$keyrano_force_ssl_admin)",
    );
    expect(compose).toContain("['localhost', '127.0.0.1', '::1']");
    expect(compose).toContain(
      "if ('false' === $$keyrano_force_ssl_admin && !$$keyrano_local_http)",
    );
    expect(exampleEnvironment).toContain(
      "KEYRANO_STAGING_FORCE_SSL_ADMIN=true",
    );
  });

  it("bootstraps the Germany-first locale and WooCommerce market deterministically", () => {
    for (const expected of [
      "wp language core install de_DE --activate",
      "wp language plugin install woocommerce de_DE",
      "WP_CLI_CACHE_DIR: /tmp/wp-cli-cache",
      "wp option update woocommerce_currency EUR",
      "wp option update woocommerce_default_country DE",
      "wp option update woocommerce_default_customer_address base",
      "wp option update woocommerce_specific_allowed_countries '[\"DE\"]' --format=json",
      "wp option update woocommerce_coming_soon no",
      "--name=sample-page",
    ]) {
      expect(compose).toContain(expected);
    }
  });
});

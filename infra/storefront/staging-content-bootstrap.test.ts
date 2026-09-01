import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  "infra/wordpress/keyrano-content-bootstrap.php",
  "utf8",
);
const compose = readFileSync("infra/docker/compose.staging.yaml", "utf8");
const styles = readFileSync(
  "apps/wordpress/keycore-platform/assets/keyrano.css",
  "utf8",
);

describe("staging help, legal and footer content bootstrap", () => {
  it("installs the editable content bootstrap through a read-only staging mount", () => {
    expect(compose).toContain(
      "wp eval-file /opt/keyrano-bootstrap/keyrano-content-bootstrap.php",
    );
    expect(compose).toContain(
      "../wordpress/keyrano-content-bootstrap.php:/opt/keyrano-bootstrap/keyrano-content-bootstrap.php:ro",
    );
  });

  it("defines each required page once with stable slugs", () => {
    for (const slug of [
      "haeufige-fragen",
      "kontakt",
      "key-aktivieren",
      "bestellstatus",
      "impressum",
      "datenschutz",
      "agb",
      "widerrufsbelehrung",
    ]) {
      expect(bootstrap.match(new RegExp(`'${slug}' =>`, "gu"))).toHaveLength(1);
    }
    expect(bootstrap).toContain("get_page_by_path($slug, OBJECT, 'page')");
    expect(bootstrap).toContain("KEYRANO_CONTENT_HASH_META");
    expect(bootstrap).toContain("$managed_hash === ''");
    expect(bootstrap).toContain("! hash_equals($managed_hash");
  });

  it("uses the verified WooCommerce category slugs for the preserved Shop links", () => {
    for (const [label, slug] of [
      ["Games", "games"],
      ["Software", "software"],
      ["Gutscheinkarten", "gutscheinkarten-prepaid"],
      ["Abonnements", "abonnements"],
    ]) {
      expect(bootstrap).toContain(`'${label}' => '${slug}'`);
    }
    expect(bootstrap).toContain("get_term_by('slug', $slug, 'product_cat')");
    expect(bootstrap).toContain("get_term_link($term)");
    expect(bootstrap).toContain("keyrano_rewrite_shop_links");
  });

  it("updates the canonical active footer instead of an arbitrary footer post", () => {
    expect(bootstrap).toContain(
      "get_block_template(get_stylesheet() . '//footer', 'wp_template_part')",
    );
    expect(bootstrap).toContain("$footer_post_id > 0");
    expect(bootstrap).toContain("get_post($footer_post_id)");
    expect(bootstrap).not.toContain("'numberposts' => 20");
    expect(bootstrap).not.toContain(
      "wp_get_object_terms($post->ID, 'wp_theme'",
    );
  });

  it("mutates nested footer blocks by reference instead of an expression copy", () => {
    expect(bootstrap).toContain("foreach ($block['innerBlocks'] as &$inner)");
    expect(bootstrap).not.toContain(
      "foreach (($block['innerBlocks'] ?? []) as &$inner)",
    );
  });

  it("keeps the responsive class in block attributes and rendered wrapper markup", () => {
    expect(bootstrap).toContain("keyrano_add_block_class");
    expect(bootstrap).toContain("new WP_HTML_Tag_Processor($content)");
    expect(bootstrap).toContain("$processor->add_class($class)");
  });

  it("resolves footer destinations from WordPress objects without a staging origin", () => {
    expect(bootstrap).toContain("get_page_by_path($slug, OBJECT, 'page')");
    expect(bootstrap).toContain("get_permalink($page)");
    expect(bootstrap).not.toContain("staging.keyrano.de");
  });

  it("adds only the two missing footer groups and refuses to overwrite occupied manual columns", () => {
    expect(bootstrap).toContain("keyrano_column_is_empty");
    expect(bootstrap).toContain(
      "Footer has no empty column for Hilfe & Service. Manual content was preserved.",
    );
    expect(bootstrap).toContain(
      "Footer has no empty column for Rechtliches. Manual content was preserved.",
    );
    expect(bootstrap).toContain("parse_blocks((string) $post->post_content)");
    expect(bootstrap).toContain("wp_update_post(['ID' => $post->ID");
    for (const label of [
      "Häufige Fragen",
      "Kontakt",
      "Key aktivieren",
      "Bestellstatus",
      "Impressum",
      "Datenschutz",
      "AGB",
      "Widerrufsbelehrung",
    ]) {
      expect(bootstrap).toContain(`'${label}' =>`);
    }
  });

  it("keeps unavailable workflows fail closed and legal copy visibly provisional", () => {
    expect(bootstrap).not.toContain("<form");
    expect(bootstrap).not.toContain("order_id");
    expect(bootstrap).not.toContain("email_address");
    expect(bootstrap).toContain("Diese Seite sendet keine Nachricht.");
    expect(bootstrap).toContain(
      "Es gibt keine öffentliche Suche per Bestellnummer oder E-Mail-Adresse.",
    );
    expect(bootstrap).toContain(
      "Dieser Inhalt ist nicht rechtlich geprüft und nicht produktionsbereit.",
    );
    expect(bootstrap).toContain(
      "[Unternehmensname, Rechtsform und Anschrift ergänzen]",
    );
    expect(bootstrap).toContain("[Offizielle Aktivierungsschritte ergänzen]");
  });

  it("provides bounded responsive page and footer layouts", () => {
    expect(styles).toContain(".keyrano-content-shell");
    expect(styles).toContain(".keyrano-footer-columns");
    expect(styles).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain(
      ".keyrano-footer-columns { grid-template-columns: 1fr; }",
    );
  });
});

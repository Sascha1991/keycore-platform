# Storefront Design Editability Boundary

## Ownership

WordPress and WooCommerce own the editable KeyRaNo presentation layer. The
product owner must be able to use the native Site Editor, theme styles,
templates, template parts, navigation and page editor for:

- global and text colors;
- fonts and typography;
- button appearance;
- header, footer and navigation;
- page copy and homepage sections;
- general spacing and visual layout; and
- WooCommerce presentation templates where their data contract remains safe.

The KeyCore plugin must not hide native theme template parts, replace the site
header/footer, define global brand colors or fonts, or make ordinary content
changes require edits to security-sensitive PHP or TypeScript. Elementor and
other page builders are not required by this boundary.

## KeyCore Boundary

KeyCore owns facts and authorization, not visual design. Plugin code may render
minimal semantic markup for functional data that WordPress cannot safely own,
including eligibility facts, customer-safe state labels, owned purchase data
and the explicit secure-reveal form. Styling for those components must inherit
theme tokens where practical and must not alter authorization behavior.

The following remain exclusively controlled by KeyCore regardless of theme or
template customization:

- WordPress-to-KeyCore identity mapping;
- exact purchase ownership and account authorization;
- signed bridge request and response verification;
- order, payment, procurement and fulfillment authority;
- nonce, same-origin and reveal rate checks;
- vault authorization and Product Key decryption; and
- omission of key plaintext from ordinary pages and WordPress metadata.

Templates may change labels, arrangement and visual presentation, but they must
consume only the customer-safe projections returned by these boundaries. A
theme, page or WooCommerce order is never evidence that a KeyCore order is
paid, owned, fulfilled or eligible for reveal.

## Checkout Integration

The synthetic staging checkout uses native WooCommerce payment-method
extension points. WooCommerce collects browser input and renders confirmation;
the signed adapter sends only a bounded product reference, expected amount,
currency, quantity, checkout timestamp, idempotency token and synthetic outcome
to KeyCore. KeyCore resolves authoritative catalog/customer facts, persists the
order/payment state and returns only a safe result and internal order ID.

No Product Key, supplier identifier, cost, margin, payment credential or raw
provider payload may be stored in WordPress/WooCommerce metadata or exposed to
theme templates.

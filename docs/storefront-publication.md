# Storefront Publication

KS-05-03 adds the supplier-neutral foundation for publishing canonical KeyCore products to a storefront. It does not connect to a live WooCommerce store, implement checkout, payment, procurement, fulfillment, GAMIVO or production publication.

## Source Of Truth

KeyCore remains the source of truth for canonical product identity, Germany eligibility, publication state and remote storefront mapping. WooCommerce is treated as a remote presentation target.

The durable identity relation is:

```text
ProductId + storefront -> remote WooCommerce product ID
```

The mapping is idempotent and fail-closed. A `ProductId + storefront` mapping cannot be silently moved to another remote product ID, and one remote WooCommerce product ID cannot be assigned to two KeyCore products within the same storefront.

## Publication States

The state model is:

- `NOT_PUBLISHED`
- `PENDING_CREATE`
- `PUBLISHED`
- `PENDING_UPDATE`
- `UNPUBLISH_PENDING`
- `UNPUBLISHED`
- `BLOCKED`
- `FAILED`
- `REVIEW_REQUIRED`

`PENDING_CREATE` and `REVIEW_REQUIRED` prevent blind duplicate creation. Ambiguous create outcomes and local persistence failures after a remote create require reconciliation before another create is attempted.

## Eligibility

A product is publishable only when all of these are true:

- canonical product exists and is active;
- product is not manually disabled;
- canonical mapping state is safe: `UNMATCHED`, `AUTO_MATCHED` or `MANUAL_MATCHED`;
- at least one active supplier offer has Germany decision `ALLOWED`;
- at least one eligible offer is in stock unless the storefront policy explicitly allows out-of-stock display;
- required customer-facing fields are present;
- sell price is returned by the explicit storefront price boundary.

`REVIEW_REQUIRED`, conflicting or detached identity states block publication. Germany `BLOCKED`, `REVIEW_REQUIRED` and `DISABLED` offers are excluded from eligible storefront stock and price inputs.

## WooCommerce Boundary

The adapter uses the current WooCommerce REST API integration path `wp-json/wc/v3`. WooCommerce documentation describes the REST API as integrated with the WordPress REST API, using JSON request/response bodies, pagination on list endpoints and consumer key/secret authentication. Product operations are modeled through the documented products endpoint:

- `POST /wp-json/wc/v3/products` for create;
- `GET /wp-json/wc/v3/products/<id>` for read;
- `PUT /wp-json/wc/v3/products/<id>` for update;
- `PUT /wp-json/wc/v3/products/<id>` with `status=draft`, `catalog_visibility=hidden` and `stock_status=outofstock` for soft-unpublish.

KS-05-03 intentionally does not call the WooCommerce delete endpoint.

References:

- [WooCommerce REST API documentation](https://developer.woocommerce.com/docs/apis/rest-api/)
- [WooCommerce products REST API documentation](https://developer.woocommerce.com/docs/apis/rest-api/v3/products/)

## Safe Payloads

Storefront payloads include customer-safe fields:

- title;
- slug;
- safe description;
- regular price from the price boundary;
- stock status derived from eligible Germany-allowed offers;
- KeyCore product ID, publication version and fingerprint metadata.

Payloads must not include supplier IDs, supplier offer IDs, supplier costs, raw supplier payloads, credentials, product keys, customer records or order records.

## Soft Unpublish

When eligibility is lost after publication, the adapter updates the known remote product to draft, hides it from catalog visibility and marks it out of stock. It does not hard-delete the WooCommerce product.

## PostgreSQL Model

Migration `005_storefront_publication` creates `storefront_publications` with:

- `product_id`;
- `storefront`;
- optional `remote_product_id`;
- publication state;
- publication version;
- fingerprint;
- slug;
- timestamps;
- reconciliation and error fields.

The migration enforces:

- one publication mapping per `ProductId + storefront`;
- one remote product ID per storefront;
- foreign-key ownership by canonical `products(id)`.

The migration is reversible and does not rewrite catalog, offer, order or supplier state.

## Audit

Publication emits audit-safe `STOREFRONT_*` events for create, update, unpublish, failure and reconciliation-required outcomes. Metadata contains safe identifiers, state, reason code and publication version only.

## Local Configuration

`.env.example` includes local placeholder values:

- `WOOCOMMERCE_BASE_URL`;
- `WOOCOMMERCE_CONSUMER_KEY`;
- `WOOCOMMERCE_CONSUMER_SECRET`.

No live credentials, real domains, product keys, customer data or order data are required for KS-05-03.

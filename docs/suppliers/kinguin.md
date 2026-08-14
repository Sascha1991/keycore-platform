# Kinguin Supplier Connector Foundation

KS-04-01 implements the Kinguin connector foundation from the official Kinguin eCommerce API documentation repository:

https://github.com/kinguinltdhk/Kinguin-eCommerce-API

Documents reviewed:

- `README.md`
- `quickstart/README.md`
- `api/products/v1/README.md`
- `api/products/v2/README.md`
- `api/order/v1/README.md`
- `api/order/v2/README.md`
- `features/Webhooks.md`
- `features/ProductUpdates.md`
- `features/BuyingPreorders.md`
- `features/ReturnKeys.md`
- `CHANGELOG.md`

## Authentication And Environments

Kinguin uses the `X-Api-Key` header. The adapter reads the API key only through the configured `SecretProvider` name `KINGUIN_API_KEY`. It never hard-codes, logs, audits, queues, or exposes the API key.

Sandbox and production use separate configuration:

- `KINGUIN_ENVIRONMENT`
- `KINGUIN_API_BASE_URL`
- `KINGUIN_API_KEY`
- `KINGUIN_WEBHOOK_PRODUCT_UPDATE_SECRET`
- `KINGUIN_WEBHOOK_ORDER_COMPLETE_SECRET`
- `KINGUIN_WEBHOOK_ORDER_STATUS_SECRET`

Production purchasing is disabled in this task. Live read-only testing is not enabled by default and CI uses only synthetic fake transport fixtures.

## HTTP Transport

`KinguinHttpClient` wraps a Kinguin-specific `KinguinHttpTransport`. The transport boundary supports:

- configurable base URL;
- bounded timeout;
- response-size limits;
- safe headers;
- JSON parsing and validation;
- HTTP status to supplier-neutral error mapping;
- deterministic fake transport tests.

The Node fetch transport uses manual redirects. Unit and CI tests do not perform live HTTP calls.

## Products, Offers, And Reference Data

Implemented documented endpoints:

- `GET /v1/products`
- `GET /v1/products/{kinguinId}` through documented v1 search fixtures and `GET /v2/products/{productId}` for direct product lookup
- `GET /v1/regions`
- `GET /v1/platforms`
- `GET /v1/genres`

Search supports `page`, `limit`, `updatedSince`, and `updatedTo`. The documented maximum `limit` is `100`; larger requests fail before transport.

Products and offers normalize into existing supplier-neutral KeyCore records. Kinguin prices are mapped as EUR `Money` minor units without JavaScript floating-point arithmetic in the KeyCore money representation.

Raw Kinguin payloads are not persisted as canonical models.

## Offer-To-Product Mapping

Kinguin ordering requires the exact Kinguin `productId` and `offerId`. The adapter therefore maintains an explicit `SupplierOfferId` to `SupplierProductId` mapping boundary.

The in-memory foundation index can be seeded by the application/catalog-sync layer and is also populated from known Kinguin product or catalog responses. It fails closed if a supplier offer is later observed under a different supplier product.

Purchase execution does not scan `GET /v1/products` to resolve an offer. The purchase path resolves the mapped supplier product first, refreshes the product through `GET /v2/products/{productId}`, verifies the product still contains the exact offer, and then builds `POST /v2/order` with the exact mapped product and offer identifiers.

Missing mappings fail closed as `NOT_FOUND`. Conflicting mappings fail closed as `CONFLICT`. No title matching or undocumented offer lookup endpoint is used.

## Region Evidence

Kinguin `countryLimitation` is treated as excluded country codes. It is never interpreted as an allow list.

The adapter maps:

- `regionalLimitations`;
- `countryLimitation`;
- `regionId`;
- activation details hints for VPN or foreign-account requirements.

Missing structured region data remains unknown/review-required evidence. Contradictory structured data, such as `Region free` text combined with exclusions, remains contradictory/review-required. Final Germany eligibility is not implemented in this task.

## Order Creation And Reconciliation

Implemented documented order foundation:

- `POST /v2/order`
- `GET /v1/order/{orderId}` for reconciliation

Purchase payload fields:

- `products[].productId`
- `products[].qty`
- `products[].price`
- `products[].keyType`
- `products[].offerId`
- `orderExternalId`

The adapter enforces documented limits before transport:

- maximum quantity per normal offer: `9`;
- maximum products array items: `10`.

`orderExternalId` is used as a supplier-side reference, but the adapter does not claim Kinguin provides full idempotency guarantees. A timeout after `POST /v2/order` is treated as `AMBIGUOUS` and must be reconciled before any cross-supplier fallback.

## Key Retrieval And KeyVault Boundary

Implemented documented key endpoint:

- `GET /v2/order/{orderId}/keys`

Supported content types:

- `text/plain`
- `image/jpeg`
- `image/png`
- `image/gif`

The Kinguin `serial` field is product-key material. It is never logged, audited, queued, persisted plaintext, or returned as ordinary product/order DTO content. The adapter can hand serial bytes directly to `ProductKeyVaultPort.storeReceivedKey`.

Tests use synthetic canary keys only.

## Return Keys

Implemented documented mapping for:

- `POST /v2/order/{orderId}/keys/return`

Kinguin return-key behavior is modeled as a supplier refund-claim boundary. Full customer refund and payment workflows remain later tasks.

## Webhooks

Implemented webhook foundation for:

- `product.update`
- `order.status`
- `order.complete`

Kinguin documentation currently documents `product.update` and `order.status`; `CHANGELOG.md` states `order.complete` is deprecated. The adapter classifies `order.complete` only for compatibility and documents it as deprecated.

Verification uses the documented headers:

- `X-Event-Name`
- `X-Event-Secret`

No HMAC/signature algorithm is invented. Missing or mismatched secrets fail closed. Valid events are normalized to safe queue payloads with duplicate detection based on event name, primary reference, and `updatedAt`.

Webhook receipt does not expose keys. Downstream retrieval and customer fulfillment remain later tasks.

## Error Mapping

HTTP and transport failures map into supplier-neutral categories:

- `AUTHENTICATION`
- `AUTHORIZATION`
- `RATE_LIMIT`
- `TIMEOUT`
- `TRANSIENT`
- `INVALID_RESPONSE`
- `NOT_FOUND`
- `OUT_OF_STOCK`
- `REJECTED`
- `CONFLICT`
- `UNKNOWN`

Raw response bodies are not exposed in `SupplierError` messages.

## Rate Limits

The reviewed Kinguin documentation does not define numeric API rate limits. The adapter maps HTTP `429` to `RATE_LIMIT` and omits `rateLimit` metadata from health responses when numeric limits are unknown.

Unknown rate-limit data is not represented as `{ limit: 0, remaining: 0 }`, because supplier routing treats `remaining <= 0` as exhausted capacity. Kinguin can remain routable when policy allows unknown health and all other eligibility rules pass. No fake high capacity value is invented.

## Known Ambiguities

- The docs use `productId` in `POST /v2/order` but one table labels its type as `int`; examples show a string. The adapter treats `productId` as a string as shown in examples and product v2 docs.
- Webhook verification is documented as a shared `X-Event-Secret` header, not as an HMAC signature. The adapter does not invent a signature algorithm.
- `order.complete` is deprecated according to the official changelog but remains listed in KS-04-01 requirements. It is supported only as a compatibility classification.
- Kinguin does not document strong idempotency guarantees for `orderExternalId`; duplicate/timeout behavior remains subject to reconciliation.
- Durable production persistence for `SupplierOfferId` to `SupplierProductId` mappings remains a later application/catalog-sync responsibility. KS-04-01 provides the adapter-local boundary and fail-closed semantics.

## Deferred Work

- Live sandbox read-only tests, disabled by default.
- Production approval artifacts and live credentials.
- Real purchasing enablement.
- Final Germany eligibility.
- Pricing engine, WooCommerce publication, customer checkout, fulfillment, invoice, email, and GAMIVO.

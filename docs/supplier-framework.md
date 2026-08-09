# Supplier Framework

## Architecture

KeyCore uses ports and adapters for suppliers:

```text
KeyCore Core
  -> SupplierPort
    -> Supplier Adapter
      -> External Supplier
```

KS-03-01 adds the reusable supplier framework and deterministic MockSupplier only. No real supplier is connected, no supplier credentials are used, and no production supplier approval is granted.

## SupplierPort Responsibility

`SupplierPort` describes supplier behavior without naming a supplier, transport, endpoint, credential, or API payload. It covers:

- full catalog listing;
- optional delta catalog listing;
- product lookup;
- offer lookup;
- price lookup;
- region evidence lookup;
- purchase submission;
- purchase reconciliation;
- optional key-handle retrieval;
- health/rate-limit status;
- optional refund claim submission.

## Capability Model

`SupplierCapabilities` describes behavior only. It includes support flags for full catalog, delta catalog, price lookup, region evidence, purchase, reconciliation, delayed fulfillment, key retrieval, refund claims, and health/rate-limit information.

Capabilities must not contain credentials, endpoint URLs, API keys, bearer tokens, or transport-specific configuration. Unsupported optional behavior fails with `UNSUPPORTED_CAPABILITY`.

## Normalization Boundary

Supplier adapters convert external payloads into normalized KeyCore structures before core workflows consume them.

`NormalizedSupplierProduct` keeps:

- supplier identity;
- supplier product ID;
- mapped KeyCore product summary;
- lifecycle/availability state;
- changed timestamp.

`NormalizedSupplierOffer` keeps:

- supplier identity;
- supplier offer ID;
- supplier product relation;
- mapped KeyCore offer summary;
- current price and availability;
- region evidence;
- captured timestamp;
- safe supplier reference metadata.

Supplier metadata must remain safe and non-secret. Raw request or response bodies are not part of the normalized contract.

## Internal vs Supplier IDs

Supplier IDs and KeyCore IDs use distinct branded types:

- `SupplierId`
- `SupplierProductId`
- `SupplierOfferId`
- `ProductId`
- `OfferId`
- `OrderLineId`

MockSupplier tests prove supplier-side IDs cannot be assigned to internal KeyCore ID types without an explicit mapping step.

## SupplierRegistry

`SupplierRegistry` stores adapter references only. It supports:

- registering suppliers;
- resolving a supplier by `SupplierId`;
- preventing duplicate registration;
- listing supplier identities and capabilities deterministically;
- failing for unknown suppliers.

The registry does not store credentials or supplier secrets.

## Catalog Semantics

Full catalog listing returns deterministic bounded pages. Delta listing is available only when the adapter declares `supportsDeltaCatalog`.

MockSupplier uses opaque cursors such as `mock:2`. These are deterministic in-memory cursors, not SQL offsets or external pagination claims.

## Region Evidence

Supplier region data remains structured evidence. KS-03-01 does not implement the Germany compatibility decision engine. Unknown, missing or contradictory region evidence remains review-required and is never promoted to `ALLOWED` by the mock adapter.

## Purchase Idempotency

MockSupplier models supplier purchase idempotency strongly:

- same idempotency reference plus same semantic request returns the same receipt;
- same idempotency reference plus conflicting request fails with `CONFLICT`;
- duplicate supplier purchase records are not created.

This prepares future procurement orchestration tests without implementing procurement orchestration.

## Reconciliation

MockSupplier supports deterministic reconciliation outcomes for accepted, delayed, ambiguous, unavailable and rejected synthetic purchase states. No polling, scheduling or network I/O is implemented.

## Key-Handle Boundary

Key retrieval returns a synthetic handle/reference only. It does not return plaintext product-key material and does not bypass the secure KeyVault.

## Refund Capability

Refund claims are optional. When enabled, MockSupplier creates deterministic synthetic claim references and returns the same result for duplicate semantic requests. When disabled, refund behavior fails with `UNSUPPORTED_CAPABILITY`.

## Health and Rate Limit

Supplier health uses `HEALTHY`, `DEGRADED`, `OUTAGE`, and `UNKNOWN`. Rate-limit metadata may include `limit`, `remaining`, and `resetAt`; impossible values such as `remaining > limit` fail validation.

## Error Model

Supplier errors map to supplier-neutral categories:

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
- `UNSUPPORTED_CAPABILITY`
- `UNKNOWN`

Errors may include supplier ID, operation, classification, correlation ID, and safe supplier references. They must not include credentials, raw external responses, product keys, payment credentials, or sensitive request bodies.

## Fault Injection

MockSupplier supports deterministic opt-in fault injection:

- `TIMEOUT`
- `RATE_LIMITED`
- `TRANSIENT_ERROR`
- `TERMINAL_ERROR`
- `MALFORMED_RESPONSE_SIMULATION`

Faults are configured per operation and never random.

## Observability Hooks

The framework defines supplier-neutral observability event contracts for request start/completion/failure, rate limiting, health state, purchase submission, and reconciliation attempts. No monitoring vendor is introduced.

## Contract Tests

The reusable test API is:

```ts
runSupplierContractTests({
  createSupplier: () => supplier,
  knownProductId,
  missingProductId,
  knownOfferId,
  missingOfferId,
  delayedOfferId,
  unavailableOfferId,
});
```

Future adapters can plug into the same suite through a factory and fixture expectations. The suite does not depend on MockSupplier internals.

## MockSupplier Limits

MockSupplier is infrastructure and testing only. It uses synthetic in-memory data, synthetic references, deterministic cursors, deterministic fault injection, and no network calls. It is not a production supplier adapter.

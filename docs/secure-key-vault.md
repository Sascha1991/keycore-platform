# Secure Key Vault

KS-02-03 establishes the secure product-key vault foundation. It supports development and CI validation with synthetic runtime-generated key material only. It does not authorize production key management, production master keys, real supplier key retrieval, customer portal reveal, WooCommerce authorization, or admin key-view UI.

## Threat Model

Product keys are high-value secrets. The design assumes PostgreSQL backups, Redis contents, logs, traces, audit events, queues, and repository snapshots may be inspected during support, testing, or incident response. Those surfaces must never contain plaintext product keys or master-key material.

Plaintext may exist only temporarily in application process memory while an authorized store or reveal flow is running.

## Envelope Encryption

Each stored product key receives a unique random data encryption key. The product key is encrypted with that DEK using authenticated encryption, and the DEK is wrapped by a KeyManagementProvider. PostgreSQL stores only encrypted product-key material, the wrapped DEK, algorithm metadata, key version, and ownership metadata.

## Authenticated Encryption

The current vault algorithm is `AES-256-GCM-v1`, implemented with Node.js built-in crypto. Each encryption uses a fresh 96-bit nonce and a 256-bit DEK. Authentication tags are stored separately and verified during reveal. Tampered ciphertext, nonce, tag, algorithm metadata, or wrapped DEK fails closed with a generic error.

AES-GCM also authenticates deterministic Additional Authenticated Data. The vault derives AAD from stable, non-secret metadata instead of storing a separate plaintext AAD field:

```json
{
  "algorithm": "AES-256-GCM-v1",
  "orderLineId": "<internal-order-line-id>",
  "purpose": "keycore-product-key",
  "version": 1
}
```

The canonical representation binds product-key ciphertext to its owning internal order-line ID and vault algorithm/version. Moving a complete encrypted payload to a different `encrypted_key_records.order_line_id`, or changing the authenticated context, causes reveal to fail closed.

## DEK Lifecycle

DEKs are generated with cryptographically secure randomness. A plaintext DEK is used only in memory to encrypt or decrypt one product key and is zero-filled after wrapping or unwrapping as soon as practical.

## KeyManagementProvider

The vault depends on a supplier-neutral and platform-neutral KeyManagementProvider port. It supports:

- active master-key version;
- `wrapDataKey`;
- `unwrapDataKey`;
- key-version metadata;
- rewrap-compatible rotation.

Production providers such as AWS KMS, Google Cloud KMS, Azure Key Vault, and HashiCorp Vault remain future adapters.

## Development Provider

The development/test provider accepts master-key material only from environment configuration. A developer can generate a local-only key with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set `KEYCORE_DEV_MASTER_KEY` locally. The provider fails closed when material is missing or invalid and refuses `production` mode. KS-02-03 does not authorize using this provider in production.

## Authorization Boundary

Reveal requires a `KeyAccessContext` and a `KeyAccessAuthorizationPort`. The vault does not assume that an order-line ID is sufficient authorization. Later KS-08 customer-account work must supply real customer/session ownership checks before customer reveal.

## Database Format

The existing `encrypted_key_records` table stores:

- ciphertext;
- nonce;
- authentication tag;
- wrapped data encryption key;
- algorithm;
- key version;
- owning order-line ID;
- created, rotated, and retired timestamps.

There is no plaintext-key column. Repository APIs accept `EncryptedKeyMaterial`, not plaintext product-key strings.

## Audit Behavior

The vault emits secret-safe audit events for store, reveal, denied access, rewrap, and retirement. Audit metadata may include encrypted record ID, order-line ID, actor, correlation ID, outcome, reason code, and key-management version. It must never include plaintext, ciphertext, nonce, authentication tag, DEK, wrapped DEK, or master-key material.

## Rotation and Rewrap

Rotation support unwraps the existing DEK in memory and rewraps it with the new active master key. Product-key ciphertext and its authenticated AAD do not change only because the master wrapping key changes. Production rotation scheduling is deferred.

## Backup Implications

PostgreSQL backups contain encrypted material only. Master keys must remain outside the database and outside Git. Restore validation must prove that encrypted-key records can be recovered only when the appropriate external key-management provider is available.

## Failure Behavior

Missing master-key material, production use of the development provider, unsupported algorithms, tampering, invalid wrapped DEKs, or denied authorization fail closed. Errors use generic messages and do not include secret material.

## Canary Leakage Tests

Automated tests generate unique canary material at runtime, exercise store, reveal, denied access, error paths, audit, queue/outbox metadata, and PostgreSQL persistence, and verify that canary plaintext appears only in the explicit authorized reveal result.

## Production KMS Boundary

No production KMS adapter is implemented in KS-02-03. Production KMS selection, credentials, key policies, rotation scheduling, access monitoring, backup restore drills, and production approval artifacts are deferred to later tasks and approval gates.

# KS-02-03: Secure Product-Key Vault

## Goal

Implement KeyCore's secure product-key storage foundation using envelope encryption and authenticated encryption, while keeping production key-management infrastructure behind an explicit port.

This task allows synthetic test product keys to be securely stored and recovered in development/test environments. It does not implement real supplier key delivery, customer key portal, WooCommerce access, or production KMS integration.

## Dependencies

- KS-01-01 completed and CI green
- KS-01-02 completed and CI green
- KS-02-01 completed and CI green
- KS-02-02 completed and CI green
- ADR-0001 through ADR-0012
- Specification v1.0.2

## Scope

- Envelope encryption foundation using unique per-record data encryption keys.
- AES-256-GCM authenticated encryption for product-key material.
- KeyManagementProvider port for wrapping and unwrapping data encryption keys.
- Development/test-only key-management provider that fails closed without configured key material and refuses production use.
- ProductKeyVault service with explicit authorization boundary before reveal.
- PostgreSQL encrypted-key repository adapter using the existing ciphertext-only schema.
- Rotation foundation through data-key rewrap without product-key plaintext persistence.
- Secret-safe audit events for store, reveal, denied access, rewrap, and retirement.
- Canary leakage tests.

## Acceptance Criteria

- Plaintext product keys are never stored in PostgreSQL or Redis.
- Plaintext product keys are never written to logs, traces, audit metadata, queues, exceptions, snapshots, or Git.
- Each stored key uses a unique random DEK and nonce.
- Product-key encryption uses authenticated encryption and fails closed on tampering.
- Product-key encryption authenticates canonical non-secret context, including owning order-line ID and vault algorithm/version.
- Moving encrypted material to a different order-line record fails closed during reveal.
- Data encryption keys are wrapped through a KeyManagementProvider port.
- Development provider requires environment-supplied master-key material and refuses production mode.
- Reveal requires explicit authorization context and policy approval.
- Unauthorized reveal is denied and does not decrypt.
- Audit events are useful but contain no plaintext, ciphertext, nonce, tag, DEK, wrapped DEK, or master key.
- Rewrap/rotation updates wrapped DEK and key version without re-encrypting product-key ciphertext.
- Existing `encrypted_key_records` schema stores encrypted material only and has no plaintext-key columns.
- Core/domain remains independent of PostgreSQL, Redis, and cloud KMS clients.

## Required Tests

- AES/authenticated-encryption round trip.
- Same plaintext stored twice produces different ciphertext.
- Same-order-line encrypted material decrypts with matching authenticated context.
- Changed order-line authenticated context fails.
- Swapped encrypted material between order-line records fails.
- PostgreSQL stores no plaintext key.
- Repository API accepts encrypted material, not plaintext persistence.
- Authorized reveal succeeds.
- Unauthorized reveal is denied.
- Unauthorized reveal does not decrypt.
- Tampered ciphertext fails.
- Tampered authentication tag fails.
- Tampered nonce/IV fails.
- Invalid wrapped DEK fails.
- Missing development master key fails closed.
- Development provider refuses production mode.
- Each stored key uses independent encryption material.
- Master key version is persisted.
- Rewrap changes wrapped DEK/key version without requiring product-key plaintext persistence.
- Rewrap does not change product-key ciphertext or authenticated ownership context.
- Secret-safe audit events for store, reveal and denied access.
- Canary plaintext does not leak into logs, exceptions, PostgreSQL, queue/outbox metadata, audit payloads, or serialized encrypted metadata.
- Migrations/schema still contain no plaintext-key column.
- Core/domain imports no PostgreSQL, Redis, or cloud-KMS clients.

## Forbidden Scope

- Kinguin, GAMIVO, or another real supplier.
- Supplier key retrieval.
- Stripe or payment execution.
- Procurement execution.
- Customer key portal.
- WooCommerce authorization.
- Customer emails containing keys.
- Invoices.
- Production KMS.
- Production deployment.
- Admin key-view UI.
- Fraud logic.
- KS-02-04 or any later task.

## Risk Level

Critical.

## Human Approval Requirement

Review/merge required. No production KMS approval is granted by this task.

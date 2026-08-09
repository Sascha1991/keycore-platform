# ADR-0005: Secure Product-Key Vault

Status: Accepted

## Decision

Product keys are stored in a secure vault using envelope encryption and authenticated encryption. Each stored secret uses a unique data encryption key. Master keys are stored outside the database and Git.

## Requirements

- Plaintext keys may exist only temporarily in process memory.
- Authorization must be checked immediately before decryption.
- Reveals are audited without logging the key.
- Plaintext keys must never appear in WooCommerce metadata, logs, traces, analytics, exceptions, queues, caches, backups, or test snapshots.
- Key rotation must support rotating master keys without exposing plaintext.
- Backups must contain encrypted payloads only.
- Automated canary leakage tests are release-blocking.

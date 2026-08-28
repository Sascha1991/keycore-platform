# Backup and Restore Validation

KS-10-01 defines validation and operating procedure. KS-10-02 adds a
deterministic manifest and automated synthetic PostgreSQL restore drill.
Production backup storage, scheduling and retention are not connected or
approved.

## Backup Boundary

Use PostgreSQL-native, encrypted-at-rest storage for database backups. A backup
contains encrypted fulfillment ciphertext, nonce, authentication tag, wrapped
DEK and non-secret context metadata. It must contain no Product Key plaintext,
application log, environment file, database credential or external master key.
Master-key custody remains outside PostgreSQL and outside backup storage.

For each backup, retain a canonical non-secret manifest with backup ID, UTC
creation time, schema/migration identity, content SHA-256,
encrypted-fulfillment digest, Operations Control/history digest and safe row
counts. The inspector recomputes the content checksum and the validator
recomputes the manifest checksum. Do not print
connection strings or dump contents. A failed dump/upload/digest/validation is
an operational failure and triggers `BACKUP_STALE` or
`RESTORE_VALIDATION_FAILED` as applicable.

## Isolated Restore Drill

1. Obtain explicit operator authorization and a synthetic/non-production
   backup.
2. Create a new isolated PostgreSQL database or schema; never target the normal
   developer, staging or production database.
3. Verify manifest digest before restore.
4. Restore with credentials supplied through the approved secret mechanism,
   never command-line output or repository files.
5. Verify migration version, required constraints, encrypted fulfillment row
   counts, all Operations Control rows and append-only control history.
6. Verify no plaintext-key columns/material and no embedded master key exist.
7. Keep external KMS/master-key access separate. Metadata validation succeeds
   without requesting plaintext; a later authorized functional drill may prove
   KMS availability without bulk decryption.
8. Destroy the isolated restore environment after evidence is retained.

`BackupRestoreValidationService` accepts only a disposable target with a
`keycore_restore_` identifier. It fails closed on content/manifest integrity,
schema/migration identity, encrypted-fulfillment digest or control/history
digest mismatch, plaintext fields, embedded master keys/credentials and count
mismatch. `SyntheticRestoreDrillService` always cleans up its target.

PostgreSQL integration coverage creates two disposable isolated schemas, writes
only synthetic encrypted fulfillment material, applies a synthetic global
pause, restores equivalent encrypted/control state, verifies all digests and
destroys the target. No decryption or master key is required. This is local/CI
evidence, not a production restore drill.

RPO, RTO, retention duration, storage provider, schedule, access policy and
restore-drill approval remain human decisions before production readiness.

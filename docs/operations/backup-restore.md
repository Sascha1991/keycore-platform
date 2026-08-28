# Backup and Restore Validation

KS-10-01 defines validation and operating procedure; production backup storage,
scheduling and retention are not connected or approved.

## Backup Boundary

Use PostgreSQL-native, encrypted-at-rest storage for database backups. A backup
contains encrypted fulfillment ciphertext, nonce, authentication tag, wrapped
DEK and non-secret context metadata. It must contain no Product Key plaintext,
application log, environment file, database credential or external master key.
Master-key custody remains outside PostgreSQL and outside backup storage.

For each backup, retain a non-secret manifest with backup ID, UTC creation time,
schema migration version, byte size and SHA-256 integrity digest. Do not print
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
   counts, four Operations Control rows and append-only control history.
6. Verify no plaintext-key columns/material and no embedded master key exist.
7. Keep external KMS/master-key access separate. Metadata validation succeeds
   without requesting plaintext; a later authorized functional drill may prove
   KMS availability without bulk decryption.
8. Destroy the isolated restore environment after evidence is retained.

`BackupRestoreValidationService` fails closed on integrity mismatch, plaintext
fields, embedded master keys/credentials, schema mismatch, encrypted-row count
mismatch or Operations Control/history mismatch. Tests use synthetic metadata
and never reference the known real fulfillment.

RPO, RTO, retention duration, storage provider, schedule, access policy and
restore-drill approval remain human decisions before production readiness.

# Project Constitution

These rules override convenience, speed and local implementation preferences.

1. Product keys must never be stored unencrypted at rest.
2. Product keys must never appear in logs, traces, analytics, exceptions or test snapshots.
3. API credentials, payment credentials and secrets must never be committed to the repository.
4. An offer may be published only when Germany compatibility is positively established.
5. Unknown, contradictory or incomplete region data must fail closed.
6. VPN-dependent activation offers must not be sold unless explicitly approved in a future policy change.
7. Payment, procurement and refund operations must be idempotent.
8. A customer must never be charged twice because of retries, race conditions or webhook replay.
9. A supplier purchase must never be repeated blindly after an ambiguous timeout.
10. Production deployment requires human approval.
11. No agent may deploy directly to production.
12. Every critical business rule requires automated tests.
13. Every database schema change requires a reversible migration.
14. Every externally visible behavior change requires documentation.
15. Customer access to keys must be authorized against the owning order and customer identity.
16. Administrative access must use least privilege.
17. Personal data collection must be minimized.
18. Security events and financial events must be auditable without exposing secrets.
19. Supplier-specific behavior must remain outside the generic platform core.
20. The platform must continue to operate safely during partial supplier, payment or mail outages.

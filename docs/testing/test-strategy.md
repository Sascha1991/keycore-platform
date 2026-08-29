# Test Strategy

KeyCore uses layered release-blocking checks:

1. unit tests prove domain rules and fail-closed validation;
2. adapter and contract tests prove supplier, payment, queue and transport
   boundaries;
3. PostgreSQL and Redis integration tests exercise real isolated services;
4. KS-11-02 acceptance scenarios compose implemented application services into
   critical synthetic customer and order journeys; and
5. `npm run catalog:scale` executes KS-11-03 once in the PostgreSQL CI job with
   50,000 paged synthetic products, baseline/refresh/replay and safe evidence;
6. `npm run order:concurrency` executes KS-11-04 with real PostgreSQL
   repositories, independent competing clients and omission-first evidence;
7. `npm run security:assessment` executes KS-11-05's SEC-001 through SEC-020
   release gate with focused production-facing tests and omission-first
   evidence;
8. `npm run recovery:exercise` executes KS-11-06's REC-001 through REC-018
   native PostgreSQL backup, isolated restore, Redis-loss and application
   continuity exercise;
9. `npm run uat:validate` validates the deterministic KS-11-07 scenario,
   readiness, result, residual-risk, evidence and human-approval package; and
10. KS-11-07 human reviewers separately execute actual UAT after the required
    browser surfaces exist.

`npm run check` is the repository quality gate. `npm run e2e:acceptance` is the
focused acceptance command and emits safe CI evidence. Tests use injected clocks,
bounded integration timeouts and deterministic adapters. Production services,
credentials, customer data and Product Keys are prohibited in automated tests.

The catalog scale suite is excluded from the ordinary Vitest command to avoid
running the same 50k PostgreSQL workload twice. It remains release-blocking as a
dedicated step in the same Node/PostgreSQL quality-gate job.

The concurrency command reuses production-facing services and PostgreSQL
repositories through the focused persistence regressions. Test files execute
serially, while each race uses independent clients for its actors; this avoids
overlapping transactions on one client without imposing a repository-wide
mutex. A 60-second per-test bound and 15-minute CI step bound expose hangs and
deadlocks. The command has no external network dependency.

The security assessment runs selected unit and isolated PostgreSQL assertions
serially. Local runs may report PostgreSQL scenarios as skipped when the test
database is unavailable, but CI treats every skipped applicable SEC scenario as
a release-gate failure. SEC-020 is explicitly not applicable until this
repository owns a production HTTP edge. Unresolved Critical or High findings
also fail the security gate; automated success never grants
`SECURITY-READINESS`.

The recovery exercise creates separate ephemeral source and restore databases,
uses PostgreSQL custom-format `pg_dump`/`pg_restore`, validates the restored
schema and application state, then destroys both databases and the raw dump.
The raw backup is never archived. The native test is excluded from ordinary
Vitest execution and runs exactly once through its dedicated release-blocking
command. Local execution may explicitly skip it when PostgreSQL, Redis or client
tools are unavailable; CI provides all three and fails when any required REC
scenario is absent or skipped.

The current E2E boundary is application and persistence level. Browser/storefront
coverage must not be claimed until a real storefront transport exists and owner
UAT is completed under KS-11-07.

The UAT validator parses the five checked-in JSON artifacts. It asserts exact
UAT-001 through UAT-018 coverage, safe statuses and references, reasons for every
blocked/non-executable scenario, no initial human pass/reviewer/timestamp,
`NOT_APPROVED` human and security gates, and absence of secret-shaped material.
It is read-only and deterministic: it creates no evidence and can never mark a
scenario or approval complete.

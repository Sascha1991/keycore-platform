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
   and
7. later Phase-11 tasks separately cover security, recovery and human UAT.

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

The current E2E boundary is application and persistence level. Browser/storefront
coverage must not be claimed until a real storefront transport exists and owner
UAT is completed under KS-11-07.

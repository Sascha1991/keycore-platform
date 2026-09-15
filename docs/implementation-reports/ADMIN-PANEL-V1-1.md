# Admin Panel V1.1 Implementation Report

## Result

Admin Panel V1.1 builds on the merged V1 security and domain architecture. It
introduces a denser KeyRaNo operations workspace with shared page action bars,
KPI cards, filter panels, responsive workspace grids, consistent tables,
product and supplier media fallbacks, and polished empty and unavailable
states. Existing protected mutations remain unchanged.

Human Browser Review Correction Pass 01/13 refines the global shell and
Dashboard against the supplied Übersicht reference. It adds a coherent local
SVG icon system, integrated KeyRaNo Admin branding, active navigation states,
balanced responsive Dashboard composition and real operational modules. The
category was then ready for Human browser review; later correction passes are
recorded below as they reach that same review boundary.

Human Browser Review Correction Pass 04/13 rebuilds `Produkte / Katalog` as
an authoritative read-only workspace. Global Product KPIs, server-side search,
domain filters, stable sorting/pagination and a bounded Product detail use the
canonical Product, active supplier-offer and Storefront publication records.
No Product mutation, invented customer price or supplier-secret path was added.
The subsequent Human correction centralizes field-specific lifecycle,
platform and Product-type labels, removes duplicate fallback options and makes
platform filtering capitalization-insensitive for existing `PC`, `Xbox` and
`PlayStation` data without rewriting stored Product values.

Category 05/13 now separates authoritative Supplier master data from optional
technical integrations. Supplier creation is name-only and persists a neutral
record without credentials, capabilities, sync runs, Products, mappings or
offers. A distinct protected workflow can attach the one actually supported
staging adapter. The existing synthetic Supplier, its four Products, mappings,
offers and synchronization evidence remain unchanged. The final Human browser
review accepted Category 05/13 with this boundary intact.

Category 06/13 adds an authoritative, staging-safe Campaign workspace and a
real code-required discount path through KeyCore pricing, immutable Price Locks,
WooCommerce checkout and captured Orders. Campaigns are created as Drafts,
support percentage or fixed EUR reductions, bounded Product eligibility,
optional minimum subtotal and a concurrency-safe global usage limit. Failed or
cancelled payment attempts release their reservation; confirmed capture consumes
it and preserves an immutable Order snapshot. This category is technically ready
for Human browser review, not Human accepted.

## Functional changes

- Dashboard KPI cards are accessible links. `Aufmerksamkeit`, `In Bearbeitung`
  and `Fehlgeschlagen` use validated operational views whose PostgreSQL
  predicates match the dashboard aggregate definitions.
- The Dashboard now ranks at most three qualifying paid Products from the last
  30 days. The PostgreSQL aggregate uses the shared captured-payment state
  contract, sums Order quantity, excludes failed/unpaid Orders and applies a
  deterministic title/ID tie-break.
- Compact service status is limited to the serving Admin application and the
  PostgreSQL query that produced the page. Other services are explicitly not
  evaluated without a current authoritative health check.
- Customer, supplier, support and fraud lists retain their established search,
  filter, KPI and table presentation. The Product workspace now uses global
  Product aggregates independently from its bounded filtered result page.
- Authorized `PROJECT_OWNER` users can create a Supplier with only a normalized
  display name. Canonical UUID, internal code and idempotency identity are
  generated server-side; no provider or adapter is selected during creation.
- A new Supplier starts registered with empty capabilities and no fabricated
  synchronization, Product, mapping, offer, health or publication state. The
  existing list, global KPI, search, filters and sorting reflect the persisted
  record directly.
- A separate `Integration einrichten` workflow is available only for a Supplier
  without an integration. Its adapter registry exposes only the credential-less
  `Synthetischer Testadapter` in `STAGING`. Saving it does not test a connection
  or start synchronization, and unsupported actions are absent.
- Authorized users can rename only the Supplier display name from its detail.
  Supplier ID, integration, internal code, derived states, timestamps and
  aggregates remain immutable in that workflow.
- Product search covers title, Product UUID and verified canonical identifiers.
  Lifecycle, platform, type, current-offer, deliverability and publication
  filters are applied server-side and bound to signed cursor fingerprints.
- Product lifecycle, platform and type filters derive from shared allowlists and
  use the same field-specific German labels as list and detail. Unknown values
  are described by field rather than by the generic status fallback.
- Product detail exposes only canonical identity, lifecycle, publication and a
  maximum of 25 identifiers and supplier-offer relationships. Raw supplier
  metadata, credentials, Product Keys and ambiguous Product pricing are omitted.
- Finance and Reports share the existing captured-payment-volume contract but
  have distinct page descriptions and honest unavailable states for missing
  historical series, margin, tax and accounting authority.
- Settings preserves versioned Operations Controls and clearly separates
  deployment-controlled or unavailable configuration areas.
- Staff keeps the existing audited create, role, permission and lifecycle
  operations while presenting useful status cards and a clearer create entry.
- `Rabatte & Kampagnen` is a permission-protected management workspace with
  global KPIs, bounded search, structured filters, stable sort/pagination,
  Campaign detail, Draft-first creation, versioned editing, bounded Product
  selection and explicit lifecycle confirmations.
- Code-required Campaigns share one uppercase normalization contract between
  Admin, Storefront and persistence. The initial policy allows one non-combinable
  code per checkout. Automatic Campaigns, multiple codes and per-customer limits
  are intentionally not exposed.
- Percentage and fixed-amount discounts use integer arithmetic. A Campaign can
  apply to all eligible Products or canonical selected Product IDs. The optional
  minimum is the single eligible Product subtotal; mixed carts and quantities
  above one remain unsupported by this bounded initial integration.
- Checkout validates the original authoritative Product price, creates one
  promotion reservation, writes the discounted amount into the existing Price
  Lock and consumes usage only after payment capture. Failed, cancelled or
  blocked attempts release usage; replay uses the consumed snapshot even after
  later Campaign disablement.
- Campaign detail shows recent bounded usage and safe monetary evidence. The
  corresponding Admin Order detail renders the immutable Campaign name, code,
  rule and original/discounted/final amounts without customer secrets.

## Security and data boundaries

- Route capabilities, exact-Origin checks, path-bound CSRF, exact form fields,
  optimistic concurrency, session revocation and audit behavior are preserved.
- No second Product Key reveal path was added. No key, claim code, session,
  provider credential, ciphertext or raw audit metadata is rendered.
- Dashboard operational views are allowlisted. Their filters are included in
  signed cursor fingerprints and implemented as parameter-free fixed SQL
  predicates.
- Lists remain server-bounded and the existing independent supplier aggregates
  remain unchanged.
- Supplier viewing does not imply mutation authority. `SUPPLIER_MANAGE` is
  checked independently, and denied attempts are safely audited.
- Supplier create, integration and edit POSTs require exact fields, exact Origin
  and path-bound CSRF. Creation and integration setup are idempotent by their
  server-generated operation identities; renames use optimistic record
  versions. Each successful persistence operation and its safe audit event share
  one PostgreSQL transaction.
- Migration `034_supplier_admin_version` adds only the positive,
  default-initialized `suppliers.record_version` column and preserves all
  existing Supplier, catalog and offer data.
- Reversible migration `035_supplier_integrations` adds the optional one-to-one
  integration boundary and backfills only known legacy synthetic Supplier
  records. Its rollback drops integration metadata while preserving Suppliers,
  catalog records, mappings, offers and synchronization history. No dependency
  or production configuration change is required.
- Reversible migration `036_promotion_campaigns` adds Campaigns, canonical
  Product eligibility and reservation/consumption snapshots. Database
  constraints enforce normalized unique codes, valid schedules and positive
  non-zero payable totals; a trigger prevents mutation or deletion of consumed
  Order evidence. No existing Order, Product, Supplier or UAT fixture is reset.
- `PROMOTION_VIEW` and `PROMOTION_MANAGE` are enforced independently of hidden
  controls. All Admin mutations retain exact Origin, path-bound CSRF, exact-field
  parsing, optimistic versions, transactional audit and no state-changing GET.

## Reference review

| Reference                    | Result                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Gesamtübersicht              | `PARTIALLY_COVERED`: reference composition, icons and real operational modules; no authoritative historic capture series or tax-status domain |
| Berichte & Statistiken       | `PARTIALLY_ALIGNED`: KPI and analysis layout present; no fabricated time series or category split                                             |
| Einstellungen                | `PARTIALLY_ALIGNED`: tabbed hierarchy and real Operations Controls; unsupported settings remain unavailable                                   |
| Bestellungen                 | `ALIGNED`: action bar, real filters, state-rich bounded table and detail path                                                                 |
| Finanzen                     | `PARTIALLY_ALIGNED`: authoritative payment/refund metrics; no invented net profit, tax or margin                                              |
| Lieferanten                  | `HUMAN_ACCEPTED`: Supplier master data, optional staging integration, audited creation and display-name editing                               |
| Kunden                       | `ALIGNED_WITH_DOMAIN_LIMIT`: account/order summaries; no invented names, onboarding or authentication mutation                                |
| Mitarbeiter & Rollen         | `ALIGNED`: real staff lifecycle and permission actions retained in the denser layout                                                          |
| Produkte / Katalog           | `READY_FOR_HUMAN_BROWSER_REVIEW`: global KPIs, real filters, bounded detail and semantic fallback media; no unsafe write or invented price    |
| Rabatte & Kampagnen          | `READY_FOR_HUMAN_BROWSER_REVIEW`: authoritative code-required Campaign management, checkout application and immutable Order evidence          |
| Support                      | `ALIGNED`: real cases, priorities, customer-visible/internal messages and transitions                                                         |
| Admin-Panel Gesamt           | `PARTIALLY_ALIGNED`: shared visual language and operational modules; deep workflows remain constrained by existing authority                  |
| Markierte Produkt-Action-Bar | `ALIGNED`: reusable title/description/search/filter/action composition implemented                                                            |

## Accepted limitations

- There is no customer admin onboarding, catalog import/create mutation,
  supplier credential onboarding, fraud
  resolution, refund initiation or production-shaped identity transport.
- Category 06 intentionally omits automatic Campaigns, multiple codes per
  Campaign, code generation, per-customer limits, audience targeting, category/
  Supplier scope, mixed carts, quantities above one and zero-payable Orders.
  Only EUR is supported. These controls are absent rather than cosmetic.
- Existing Product pricing and profitability selection remains authoritative
  before the Campaign reduction. The bounded Storefront adapter caps the accepted
  discount and never trusts a browser-submitted amount. Full and partial refund
  restoration is not implemented; a consumed use remains consumed because the
  current refund domain has no authoritative reversal event for promotions.
- A historical Dashboard capture series cannot use the established conservative
  `CAPTURED + REFUNDED + PARTIALLY_REFUNDED` contract with one consistent,
  immutable capture timestamp in the current model. The payment-volume panel
  therefore remains an explicit polished limitation instead of showing an
  inferred chart.
- Comparison periods, payment-method distribution, tax, margin and accounting
  authority are unavailable. Dashboard service status reports only states
  proven by the current request; it does not infer health from configuration.
- Product media is not present in the current Admin read model, so a stable
  platform-derived fallback is shown rather than broken or external imagery.
- Product customer pricing is not a singular authoritative field in the current
  Product model. The list and detail therefore omit a price instead of choosing
  an offer or snapshot without a proven pricing contract.
- Local Docker rendered the corrected Dashboard successfully at approximately
  1280 x 720. Direct browser review covered the full Dashboard, sparse Top
  Products and Handlungsbedarf states, refresh, notifications, sidebar active
  state, KPI quick filters, browser Back behavior and recent-order navigation.
  The first render exposed and the implementation corrected a page-level
  horizontal overflow and low-contrast Quick Access labels.
- Local Docker rendered the Product workspace at 1600 x 950 and 390 x 844.
  Browser review covered the global KPI links, expandable filter panel,
  server-applied platform/availability filters, truthful filtered empty state,
  reset, bounded Product detail and return navigation. The page remained free
  of horizontal document overflow at both viewports.
- The Human correction was rendered again at 1600 x 950. Browser inspection
  confirmed unique lifecycle/platform/type choices, German field-specific
  unknown labels, the `Verfügbares Lieferantenangebot` KPI text and consistent
  `PC`, `Xbox` and `PlayStation` presentation. An `XBOX` filter matched the
  existing mixed-case `Xbox` row, and its detail retained the same label.
- Credential management, connection testing and manual synchronization are not
  offered because no safe existing Admin operation supports them. Basic Supplier
  creation truthfully leaves the integration unconfigured and independent from
  any of those operations.
- Local browser validation of the final Supplier correction covered 1600 x 950,
  1280 x 720 and 1025 x 826. It exercised name-only Supplier creation, the
  neutral no-integration state, the separate synthetic-adapter workflow and its
  PRG detail redirect. The configured state rendered `Konfiguriert`; unsupported
  connection and synchronization actions and credential inputs remained absent.
  No page-wide horizontal overflow or browser console error was observed.
- After an Admin service restart, normal email/password login still succeeded
  and both the existing and newly created Suppliers remained visible. The
  existing `Staging Synthetic Mock` retained four Supplier Products and four
  current and available offers.
- Final Human browser review accepted Supplier creation independently from
  integration, the truthful no-integration state, the separate staging-only
  synthetic-adapter workflow, credential omission, master-data editing,
  search, filters, KPIs, detail and multiple-Supplier rendering. The adjacent
  Product workspace remained intact with 10 total and active Products, four
  Products with Supplier offers and four deliverable Products.
- Local Category 06 browser validation covered the Campaign overview and detail
  at 1600 x 950, 1280 x 720 and 1025 x 826 without page-wide horizontal
  overflow. It exercised Draft creation, bounded Product search and assignment,
  explicit activation, optimistic version progression and editable master data.
  At 1025 px the four Campaign KPIs render as a stable two-column grid.
- The real local WooCommerce browser path applied the active code-required
  Campaign to `Neonpfad: Berlin`, showed the authoritative 1,94 EUR reduction
  from 12,99 EUR to 11,05 EUR and completed one synthetic successful payment.
  The confirmation exposed no Product Key. Admin then showed one consumed use,
  zero reservations and immutable Order evidence. Renaming the Campaign after
  capture did not alter the stored Campaign name, code, rule, base amount,
  discount or final amount on that Order.

## UAT and approval

Category 05/13 Human browser review is `HUMAN_ACCEPTED`. This category review
does not constitute a KS-11-07 scenario result. No Human-UAT result changed;
the authoritative total remains 11/18 PASS.
Category 06/13 is `READY_FOR_HUMAN_BROWSER_REVIEW` and is not yet Human
accepted. Its technical completion does not add or change a KS-11-07 result.
UAT-014 and UAT-017 remain technically ready but not Human-PASS. UAT-008,
UAT-010, UAT-011, UAT-013 and UAT-016 remain blocked at their documented UI or
identity boundaries. Human Acceptance remains `IN_REVIEW`, Human Approval
remains `NOT_APPROVED`, and `SECURITY-READINESS` remains `NOT_APPROVED`.

## Validation

Category 06 Promotions validation:

- Focused Campaign domain, Admin HTTP, browser adapter, checkout persistence,
  Order presentation and PostgreSQL contracts: 74 tests passed across six
  files. The focused PostgreSQL promotion and checkout group passed 12 tests,
  including an independent-connection usage-limit race, idempotency, release,
  immutable consumption evidence and the Admin Order projection.
- `npm run check`: 97 test files and 1,017 tests passed; format, lint, typecheck
  and secret scan passed.
- Security assessment: 60 passed with 345 focused exclusions.
- E2E acceptance: 16/16 passed with PostgreSQL enabled.
- Catalog scale: 10/10 passed; Order concurrency: 38/38 passed.
- Recovery harness: one local test passed and the PostgreSQL client-dependent
  exercise was skipped on the Windows host; the CI runner remains responsible
  for the complete recovery-client execution.
- Migration `036` completed an isolated `up`, `down`, `up` cycle successfully.
- UAT structure: 18 scenarios and five omission-first evidence artifacts valid.
- Development and staging Compose rendering passed.
- Composer validation, PHP 8.3 syntax and the WordPress adapter test passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: passed.

Earlier Category 05 Supplier Extension validation:

- Focused Supplier service, Admin HTTP, presentation and PostgreSQL contracts:
  72 tests passed across eight files.
- The focused PostgreSQL group contributed 18 passing tests against PostgreSQL
  16.10, including migrations `034` and `035`, neutral create, separate
  integration setup, idempotency, rollback preservation, rename, stale-write
  denial, list/search/KPI reflection, seed preservation and audit.
- `npm run check`: 95 test files and 1,004 tests passed; format, lint, typecheck
  and secret scan passed.
- Security assessment: 60 passed with 345 focused exclusions.
- E2E acceptance: 16/16 passed with PostgreSQL enabled.
- UAT structure: 18 scenarios and five omission-first evidence artifacts valid.
- Development and staging Compose rendering passed.
- Composer validation, PHP 8.3 syntax and the WordPress adapter test passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: passed.

Earlier V1.1 validation before this extension:

- Focused Admin/Product presentation: 38 tests passed.
- Product-related PostgreSQL persistence: 7 tests passed against an isolated
  PostgreSQL 16.10 container.
- `npm run check`: 844 passed, 144 service-gated tests skipped; format, lint,
  typecheck and secret scan passed.
- Security assessment: 36 passed, 369 excluded or service-gated.
- E2E acceptance: 15 passed, one PostgreSQL test service-gated.
- UAT structure: 18 scenarios and five omission-first evidence artifacts valid.
- Development/staging Compose rendering: passed.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `git diff --check`: passed.
- GitHub Quality Gates run 34367915914: Node foundation 970/970 passed,
  security assessment 60 passed with 345 focused exclusions, E2E acceptance
  16/16 passed, catalog scale 10/10 passed, concurrency 38/38 passed, recovery
  2/2 passed, PHP/WordPress passed and both Compose configurations passed.

## Deployment classification

The current V1.1 branch is `MIGRATION_REQUIRED`. Category 06 adds reversible
migration `036_promotion_campaigns`; existing volumes and all established
Supplier, Product, Order and UAT data must be preserved. No volume reset is
required. After a separately authorized merge, the supported hosted-staging
procedure must apply migrations, run the idempotent synthetic seed, and rebuild
the Admin, Storefront and WordPress services:

```bash
cd ~/keyrano/keycore-platform
git fetch origin
git switch main
git pull --ff-only origin main
set -a
. ./.env.staging.server
set +a
npm run staging:migrate
npm run staging:seed
docker compose --env-file .env.staging.server -f infra/docker/compose.staging.yaml up -d --build keycore-admin keycore-storefront wordpress
docker compose --env-file .env.staging.server -f infra/docker/compose.staging.yaml ps keycore-admin keycore-storefront wordpress postgres redis mail
```

No Hosted Staging or production deployment was performed by this task.

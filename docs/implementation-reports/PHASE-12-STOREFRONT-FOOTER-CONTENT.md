# Phase 12 Storefront Footer, Help And Legal Content

## Scope And Base

- Branch: `feature/phase-12-footer-help-legal`
- Base commit: `44765df758e1ae522477a2891ede2540b88fe44d`
- Dependency: the PR #49 Invoice Transport squash merge already present on
  `main`; Account Transport, Guest Claim and Invoice behavior are inherited
  unchanged.
- Production deployment: not performed

## Implemented

- Added eight idempotently managed, natively editable WordPress pages.
- Preserved existing manual page content and the existing Shop footer column.
- Corrected the verified Games and Software category targets without inventing
  categories or supplier/business behavior.
- Added Help & Service and Legal footer columns with responsive dark styling.
- Added accessible native Details blocks for FAQ answers.
- Kept Contact non-functional until an approved support workflow exists.
- Kept activation and legal copy as explicit, editable placeholders.

### Staging Footer Linking Correction

The first staging deployment created all eight pages but logged
`footer=unchanged` while the visible footer still contained only Shop. The
nested-block recursion iterated over an expression copy, so it found the Shop
column but did not persist changes made below the top-level block. The correction
mutates `innerBlocks` directly by reference and resolves WordPress's canonical
active footer template part before updating its concrete post. Page and category
URLs are resolved from their WordPress objects instead of constructed from a
host or path assumption. The responsive class is synchronized into both block
attributes and the persisted wrapper markup with WordPress's HTML tag processor.

The focused synthetic WordPress fixture preserved its existing logo, Shop
column, manual wrapper and copyright; corrected the four taxonomy links; added
each Help and Legal heading/link once; then produced `footer=unchanged` and an
identical content hash on the second run.

## Security And Architecture

No KeyCore business or security service changed. There is no public order lookup,
form submission, mail delivery, GET mutation, Product Key rendering or new
authorization path. Account ownership, Checkout, Invoice and Reveal remain on
their existing boundaries.

## Validation

- PHP 8.3 syntax: passed for the bootstrap and all plugin PHP files.
- Existing WordPress adapter test: passed.
- Focused footer/bootstrap tests: 10 passed.
- Focused footer, Account, Invoice and Reveal tests: 97 passed.
- Shop-only manual-footer fixture: first bootstrap reported `footer=updated`;
  the second reported `footer=unchanged`, with the same verified content hash.
- Fixture preservation: existing logo, manual wrapper and copyright remained;
  all twelve links and both new headings occurred exactly once.
- Manual-content preservation: passed; a local FAQ edit produced `preserved=1`.
- All twelve footer targets: HTTP 200 in the isolated local staging stack.
- Browser rendering: passed at desktop 1440 px, tablet 820 px and mobile 390 px.
- Browser semantics: exactly one H1 per checked page, keyboard-operable FAQ and
  no horizontal overflow.
- `npm run check`: 764 passed, 127 skipped.
- Relevant PostgreSQL staging, checkout and account tests: 5 passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Secret scan and `git diff --check`: passed.

GitHub Quality Gates are recorded in the pull request after push.

## Human Staging Verification

The product owner confirmed the rendered staging footer behavior passed. All
twelve footer links were manually followed successfully, the Help & Service and
Legal destinations remained visible, and repeated bootstrap preserved the
idempotent result. This records only the supplied staging observation; it does
not replace automated evidence or approve production.

The legal, company, support and platform-activation content remains explicitly
placeholder-based wherever reviewed real information is unavailable. No legal
or company fact was inferred by this implementation or normalization.

## Remaining Human Work

- approve and publish a secure support contact/workflow;
- provide reviewed platform activation instructions;
- replace every legal placeholder with counsel-approved real content;

UAT-002, UAT-015 and UAT-018 remain `PASS`. KS-11-07 remains incomplete and
unapproved, `SECURITY-READINESS` remains `NOT_APPROVED`, and no production
approval is granted.

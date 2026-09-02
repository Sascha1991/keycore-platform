# KS-11-07 Human UAT Checklist

Several synthetic storefront/account scenarios are now executable or partially
executable; the remaining scenarios are still blocked at their named browser
boundary. Execute only the portions classified in `docs/uat-ui-readiness.md` in
the approved staging environment. Detailed prerequisites and full human steps
are authoritative in `artifacts/user-acceptance/uat-readiness.json`.

On 2026-08-30 the product owner completed and passed UAT-001 and UAT-006 using
the synthetic staging fixture. On 2026-08-31 the product owner completed and
passed UAT-002. UAT-015 and UAT-018 were pending at that review. The product
owner subsequently confirmed UAT-018 `PASS` on 2026-09-01 and UAT-015 `PASS`
on 2026-09-02. The safe textual records are
`docs/uat/human-uat-2026-08-30.md` and
`docs/uat/open-scenario-reconciliation-2026-08-31.md`, with the later UAT-018
result in `docs/uat/human-uat-2026-09-01-invoice.md` and the UAT-015 result in
`docs/uat/human-uat-2026-09-02-account-history.md`.

| ID      | Where to go                                   | What to do                                                           | What should happen                                                   | Failure                                                         | Safe evidence                          |
| ------- | --------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| UAT-001 | Staging catalog and product pages             | Browse/search eligible, blocked and uncertain synthetic products     | Only eligible offers are purchasable; price/content are coherent     | Unsafe offer visible or supplier detail leaked                  | Redacted list and product screenshots  |
| UAT-002 | Staging checkout and Meine Kaeufe             | Buy as verified customer A; check account; test customer B           | One owned order; B denied; confirmation has no key                   | Wrong owner, disclosure, duplicate or confusing state           | Redacted checkout/account screenshots  |
| UAT-003 | Staging guest checkout                        | Buy as guest and read confirmation instructions                      | No key; instructions require an account with the checkout email      | Key shown or same-email requirement unclear                     | Redacted confirmation screenshot       |
| UAT-004 | Meine Kaeufe, Kauf hinzufuegen                | Claim once as verified same-email customer; retry                    | Purchase is permanently owned; replay denied                         | Order ID alone works, replay works or ownership disappears      | Redacted before/after/denial views     |
| UAT-005 | Purchase claim page                           | Claim as verified different-email customer                           | Safe denial with no ownership disclosure                             | Claim succeeds or response reveals sensitive detail             | Redacted denial screenshot             |
| UAT-006 | Owned purchase secure reveal action           | Reveal as owner; try as another customer; inspect other pages        | Only owner can use dedicated reveal; other pages omit the value      | Cross-customer access or value on confirmation/invoice/support  | Redacted state and denial only         |
| UAT-007 | Paid order detail                             | Observe pending, refresh, then complete synthetic fulfillment        | Clear pending state, no duplicate purchase, eventual secure access   | False ready state, duplicate effect or stuck incoherent state   | Redacted before/after screenshots      |
| UAT-008 | Customer order plus authorized operations UI  | Trigger synthetic ambiguity and inspect both views                   | Reconciliation required; no repurchase/key; customer wording is safe | Blind fallback, duplicate purchase or supplier internals leaked | Redacted customer/operator views       |
| UAT-009 | Staging sandbox checkout                      | Use sandbox failure method and refresh                               | No paid state, procurement or key; understandable retry state        | Procurement begins, false paid state or duplicate side effect   | Redacted failure/account screenshots   |
| UAT-010 | Customer order plus fraud review UI           | Trigger synthetic REVIEW and inspect both roles                      | Procurement/key blocked; internal risk detail hidden                 | Progression occurs or risk rules leak                           | Redacted customer/operator views       |
| UAT-011 | Customer order plus fraud review UI           | Trigger synthetic DENY and attempt customer progression              | Procurement/key blocked with no ordinary override                    | Progression, key access or exploitable wording                  | Redacted customer/operator views       |
| UAT-012 | Owned purchase invoice action                 | Open as owner; inspect content; try as another customer              | Correct invoice only; no key or delivery authority; other denied     | Wrong invoice, sensitive content or cross-customer access       | Redacted invoice metadata and denial   |
| UAT-013 | Customer order plus authorized refund UI      | Perform one synthetic refund, repeat, then inspect customer state    | Exactly one effect and coherent customer state                       | Duplicate refund or contradictory payment/key state             | Redacted before/after views            |
| UAT-014 | Customer support plus authorized support UI   | Create/open case, compare visibility, try another customer           | Correct ownership; internal content internal; no unnecessary key     | Cross-customer or internal/key disclosure                       | Redacted customer/support/denial views |
| UAT-015 | Meine Kaeufe                                  | Review direct and claimed purchases; check unrelated order absent    | Only owned purchases with coherent invoice/key availability          | Missing owned or visible unrelated purchase                     | Redacted list/detail screenshots       |
| UAT-016 | Registration, login and verification pages    | Try protected action unverified, verify, sign in and retry           | Unverified denied; verified correct session can proceed              | Unverified access or sensitive verification material exposed    | Redacted status and denial screenshots |
| UAT-017 | Authorized staging controls and customer page | Pause one staging operation, attempt it, restore control             | Safe temporary failure, no fallback, leak or duplicate               | Mutation proceeds unsafely or state becomes contradictory       | Redacted control/customer states       |
| UAT-018 | Complete approved staging browser journey     | Discover, authenticate, buy, fulfill, reveal, review history/invoice | One coherent secure synthetic journey                                | Any missing boundary, unsafe state or automated-only evidence   | Redacted walkthrough evidence set      |

For every row, record the result, notes, evidence references, reviewer and UTC
review time. Never capture the secure revealed value, credentials, payment
details, claim material, session data, customer personal data or production
content.

After recording a real result, set `humanAcceptance` to `IN_REVIEW` and run
`npm run uat:validate`. Do not mark a scenario `PASS` until its readiness is
`EXECUTABLE_NOW`. ROLE-UAT-05 may move UAT to `APPROVED` only after all 18 rows,
including UAT-018, have passed with safe evidence. That UAT decision does not
approve `SECURITY-READINESS` or complete Phase 11 by itself.

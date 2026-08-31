# KS-11-07 UAT Test Data

## Data Policy

Use only isolated synthetic records in the approved staging environment. Each
execution gets dedicated customers and orders so ownership and replay outcomes
remain attributable. Never reuse production exports, customer emails, payment
details, supplier responses, credentials or real Product Keys.

## Required Fixtures

| Fixture             | Safe contents                                                         | Scenarios              |
| ------------------- | --------------------------------------------------------------------- | ---------------------- |
| Catalog eligibility | Eligible, blocked and unknown-region synthetic offers                 | UAT-001, UAT-018       |
| Customer A          | Verified synthetic account with no real personal data                 | UAT-002, UAT-004..018  |
| Customer B          | Separate verified synthetic account for denial checks                 | UAT-002, 005, 006, 012 |
| Guest order         | Deterministic synthetic snapshot/order and hash-only one-time claim   | UAT-003..005, UAT-015  |
| Sandbox payment     | Provider-documented success and failure test methods                  | UAT-002, 003, 009, 018 |
| Supplier outcomes   | Deterministic success, delayed, failure and ambiguous synthetic modes | UAT-007, 008, 018      |
| Fraud outcomes      | Deterministic REVIEW and DENY synthetic signals                       | UAT-010, UAT-011       |
| Invoice             | Synthetic invoice metadata/document without sensitive delivery data   | UAT-012, UAT-018       |
| Refund and support  | Synthetic refundable order and ownership-scoped support case          | UAT-013, UAT-014       |
| Emergency controls  | Staging-only authorized pauses                                        | UAT-017                |

Claim, verification and session material must be delivered through the approved
staging channel and never copied into UAT notes, screenshots, filenames or
artifacts. Secure reveal evidence must show only state and authorization outcome;
the revealed value must be redacted before capture.

## Reset

Use repository-supported deterministic staging seed/reset procedures only.
Confirm staging identity before reset. Do not connect to production databases,
WooCommerce, payment, supplier, mail or key-management services.

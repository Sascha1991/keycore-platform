# KS-11-07 UAT Evidence Guide

## Capture Rules

Evidence proves what the human saw and did; it must not contain authority or
sensitive data. Capture the smallest redacted page region that demonstrates the
result. Keep browser address bars only when the staging origin is needed and no
sensitive query material is present.

Never capture or store:

- Product Key plaintext or encrypted key material;
- passwords, API or payment credentials;
- session, verification, claim or delivery-capability values;
- full customer email, address, payment or order personal data;
- raw supplier/payment responses or production content.

## Naming

Use `UAT-NNN-step-N-short-description.ext`, for example
`UAT-009-step-2-payment-failure.png`. Names contain no customer identifiers,
order identifiers or sensitive values. Store later human evidence only in an
approved access-controlled evidence location; repository evidence entries use a
safe relative reference or approved opaque evidence ID.

## Minimum Evidence

For `PASS`, record the start state, decisive action result and final state. For
denial scenarios, show the safe denial and unchanged ownership/state. For
`FAIL` or `BLOCKED`, capture the first decisive symptom and document concise
reproduction steps. UAT-018 requires an ordered redacted evidence set across the
complete browser journey.

## Review

The reviewer confirms redaction before attaching a reference, records their real
identity and UTC review time, and states why the expected result passed or
failed. Automated KS-11-02 through KS-11-06 artifacts may be linked as supporting
technical evidence but never as human browser evidence.

Machine-readable result evidence uses a safe repository-relative path under
`docs/` or `artifacts/`, or an approved opaque `UAT-*`/`EVIDENCE-*` identifier.
Absolute local paths and references containing secret-shaped material are
rejected. `PASS` and `FAIL` require at least one safe reference; `BLOCKED` may
omit a screenshot when the documented blocker prevented reaching a capturable
surface, but still requires notes, reason and target dependency.

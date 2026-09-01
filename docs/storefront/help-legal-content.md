# KeyRaNo Help, Legal and Footer Content

## Scope

The staging WordPress bootstrap creates editable native pages for:

- `Häufige Fragen`, `Kontakt`, `Key aktivieren` and `Bestellstatus`;
- `Impressum`, `Datenschutz`, `AGB` and `Widerrufsbelehrung`.

It also completes the existing three-column footer. The manually authored Shop
column remains in place. Only its verified category targets are normalized to
`games`, `software`, `gutscheinkarten-prepaid` and `abonnements`; the two empty
columns become `Hilfe & Service` and `Rechtliches`.

## Editability And Repetition

Pages are located by stable slug, so repeated bootstrap runs do not create
duplicates. Content created by the bootstrap carries a hash of its last managed
version. A later bootstrap may update untouched managed content, but it preserves
any page whose editor content no longer matches that hash. An already existing
manual FAQ page has no managed hash and is therefore reused without replacement.

The footer updater asks WordPress for the canonical active `footer` template
part, then parses and mutates that post's native blocks by reference. It keeps
the recognized Shop column, fills only empty columns and stops with an error
instead of overwriting unrecognized manual content. Logo/banner, copyright and
other blocks outside those empty columns remain untouched. A clean WordPress
volume receives the same native, Site-Editor-compatible footer structure.

Page destinations come from the existing page objects through `get_permalink`;
Shop destinations come from the verified `product_cat` terms through
`get_term_link`. The bootstrap therefore does not embed a staging hostname or
assume a WordPress path configuration.

## Safety Boundaries

- The Contact page has no form and sends no message. A real support contact must
  be added only after a secure support/mail workflow is approved.
- Bestellstatus links to the authenticated `Meine Käufe` area. It provides no
  public order-ID or email lookup.
- Activation cards contain visible editorial placeholders, not invented vendor
  instructions.
- Legal pages contain visible placeholders and an explicit warning that they are
  not legally reviewed or production-ready.
- Checkout, identity, ownership, Invoice and Product Key reveal behavior is not
  changed by this presentation bootstrap.

## Staging Bootstrap

Run the normal idempotent bootstrap:

```sh
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml --profile bootstrap run --rm wordpress-bootstrap
```

After a repository deployment, this creates or preserves the pages, validates
the required category slugs, completes the footer and flushes rewrite rules.

## Manual Completion

Before production readiness can be considered, the product owner must provide:

- a secure, approved support contact/workflow;
- reviewed activation instructions for each platform actually supported; and
- complete legal text and business details reviewed by qualified legal counsel.

These content approvals do not approve KS-11-07 or `SECURITY-READINESS`.

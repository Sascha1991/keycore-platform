# Visible Storefront Smoke Test

Use only the isolated synthetic staging environment. Never record passwords or
the revealed value in evidence.

1. Start Compose and run the bootstrap command from
   `docs/storefront/staging-setup.md`. Do not add a manual `--user` argument;
   the service is already configured as UID/GID `33:33`.
2. Open the configured origin (`http://localhost:18080` locally).
   Local HTTP requires the explicit ignored-environment setting
   `KEYRANO_STAGING_FORCE_SSL_ADMIN=false`; hosted HTTPS keeps it `true`.
3. Confirm the KeyRaNo header and claim “Dein Key. Direkt. Ohne Warten.”
4. Confirm six synthetic products are visible; blocked, review and unavailable
   fixtures are not purchasable. Standard customer text must be German, prices
   must use EUR/German formatting, and no sample page or duplicate theme header
   may be visible.
5. Open a product and verify price, platform, region and activation facts.
6. Add it to the cart and open checkout. Confirm the staging/no-live-payment
   notice. Do not submit a live payment.
7. Sign in as `keyrano-customer-a` using its locally generated password.
8. Open `Mein Konto -> Meine Käufe`, then “Neonpfad: Berlin”.
9. Before action, inspect the page and confirm no synthetic reveal value exists.
10. Click `Key anzeigen`. Observe the synthetic value, but do not screenshot,
    copy or record it.
11. Return to account, invoice metadata and history; confirm the value is absent.
12. Sign out, sign in as `keyrano-customer-b`, and request customer A's detail
    URL. Confirm the same safe unavailable state and no ownership disclosure.
13. Submit a reveal form without a valid nonce or from another origin and
    confirm denial.
14. Record only redacted page/status evidence and the human result. Human PASS
    and SECURITY-READINESS remain separate approvals.

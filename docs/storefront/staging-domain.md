# KeyRaNo Staging Domain

The recommended real staging origin is `https://staging.keyrano.de`. Configure
both `KEYRANO_STAGING_ORIGIN` and `KEYCORE_STAGING_PUBLIC_ORIGIN` to that exact
origin. The bridge permits only that origin, the isolated CI fixture or explicit
localhost HTTP origins. Arbitrary public HTTPS origins are not trusted.

The four production origins remain prohibited as staging:

- `https://keyrano.de`
- `https://www.keyrano.de`
- `https://keyrano.com`
- `https://www.keyrano.com`

## Human DNS and Deployment Steps

1. Provision an isolated staging host and TLS certificate.
2. Add only the `staging.keyrano.de` DNS record to that host.
3. Inject staging-only environment values through the deployment secret store.
4. Run staging preflight before starting WordPress.
5. Start Compose and run the bootstrap profile.
6. Verify cookies are Secure and the public origin is exactly the configured
   staging origin.

Do not redirect or repoint production apex/www traffic. DNS changes, TLS setup
and deployment remain human operations outside this pull request.

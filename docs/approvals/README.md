# Approval Artifacts

Approval artifacts for KeyCore gates are stored in this directory.

Agents may prepare evidence, but agents cannot approve their own gates. Each approval artifact must identify:

- gate name;
- approver role and human approver;
- UTC timestamp;
- scope;
- evidence reviewed;
- decision;
- expiration or revalidation trigger;
- residual risks.

Required gates:

- `REAL-SUPPLIER`
- `LIVE-PAYMENTS`
- `TAX-INVOICE`
- `SECURITY-READINESS`
- `PRODUCTION-RELEASE`
- `POLICY-EXCEPTION`

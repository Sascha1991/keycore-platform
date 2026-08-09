# Approval Artifact Template

Gate: `<REAL-SUPPLIER | LIVE-PAYMENTS | TAX-INVOICE | SECURITY-READINESS | PRODUCTION-RELEASE | POLICY-EXCEPTION>`

Status: `<APPROVED | REJECTED | EXPIRED | REVOKED>`

Approver role: `<PROJECT_OWNER | OPERATIONS | SUPPORT | FINANCE | SECURITY_AUDITOR | external professional role>`

Human approver: `<name and durable identity reference>`

Timestamp UTC: `<YYYY-MM-DDTHH:MM:SSZ>`

Scope:

- `<specific environment, supplier, payment mode, release, policy, or configuration>`

Evidence reviewed:

- `<link or path to evidence>`

Decision:

- `<approval or rejection summary>`

Expiration or revalidation trigger:

- `<date, release, supplier change, dependency change, incident, or policy change>`

Residual risks:

- `<known risks accepted by the human approver>`

Agent-prepared evidence:

- `<yes/no and task/commit reference>`

Agent self-approval check:

- Agents did not approve this gate: `<true/false>`

# PRE-UAT-KEY-REAL-01 - Controlled Real Product Key Retrieval and Reveal

## Status

`NOT_STARTED` and blocked pending explicit human approval.

## Objective

Verify one separately approved supplier purchase/retrieval through encrypted
KeyCore storage and owner-only customer browser reveal without exposing Product
Key plaintext in Codex, ChatGPT, GitHub, CI, logs, artifacts or evidence.

## Mandatory Gates

- approved test budget, product and supplier account;
- approved staging customer and exact ownership mapping;
- production-like KMS and durable vault readiness;
- operator approval immediately before supplier mutation and key retrieval;
- redaction-safe observation procedure with no screen capture of plaintext;
- rollback, incident and key-compromise procedures;
- SECURITY-READINESS disposition recorded by the authorized human role.

## Forbidden Automation

This task must not be started by merge, CI, deployment, scheduled job or this
preparation task. No live call, purchase, key retrieval or reveal is authorized
by this file.

import type {
  AdminOperationsControlMutationPort,
  AdminPrincipal,
  AuditEventPort,
  OperationsControlRepository,
} from "../../packages/platform/src/contracts.js";
import {
  OperationsControlService,
  type OperationsControlAuthorityPort,
} from "../../packages/platform/src/operations/operations-controls.js";
import type { AuditEvent } from "../../packages/platform/src/domain/audit.js";
import { hasAdminCapability } from "../../packages/platform/src/admin/admin-orders.js";

export class AdminOperationsControlMutation implements AdminOperationsControlMutationPort {
  public constructor(
    private readonly repository: OperationsControlRepository,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
  ) {}

  public async change(
    input: Parameters<AdminOperationsControlMutationPort["change"]>[0],
  ) {
    const authority = new PrincipalOperationsControlAuthority(input.principal);
    return new OperationsControlService(this.repository, {
      audit: this.audit,
      authority,
      environment: this.environment,
    }).changeControl(input);
  }
}

class PrincipalOperationsControlAuthority implements OperationsControlAuthorityPort {
  public constructor(private readonly principal: AdminPrincipal) {}

  public async authorize() {
    return hasAdminCapability(this.principal, "OPERATIONS_CONTROL_MANAGE")
      ? {
          actorReference: this.principal.adminId,
          status: "AUTHORIZED" as const,
        }
      : { status: "DENIED" as const };
  }
}

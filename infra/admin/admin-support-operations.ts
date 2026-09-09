import type {
  AdminPrincipal,
  AdminSupportOperationsPort,
  AuditEventPort,
  SupportCaseRepository,
  SupportOperatorAuthorityPort,
} from "../../packages/platform/src/contracts.js";
import { SupportCaseService } from "../../packages/platform/src/support/support-cases.js";
import type { AuditEvent } from "../../packages/platform/src/domain/audit.js";
import { hasAdminCapability } from "../../packages/platform/src/admin/admin-orders.js";

export class AdminSupportOperations implements AdminSupportOperationsPort {
  public constructor(
    private readonly repository: SupportCaseRepository,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
  ) {}

  public async detail(
    input: Parameters<AdminSupportOperationsPort["detail"]>[0],
  ) {
    if (!hasAdminCapability(input.principal, "SUPPORT_VIEW")) return null;
    return this.repository.findCaseById(input.caseId);
  }

  public addNote(input: Parameters<AdminSupportOperationsPort["addNote"]>[0]) {
    return this.service(input.principal).addOperatorNote(input);
  }

  public changePriority(
    input: Parameters<AdminSupportOperationsPort["changePriority"]>[0],
  ) {
    return this.service(input.principal).changePriority(input);
  }

  public transition(
    input: Parameters<AdminSupportOperationsPort["transition"]>[0],
  ) {
    return this.service(input.principal).transitionCase(input);
  }

  private service(principal: AdminPrincipal): SupportCaseService {
    return new SupportCaseService({
      audit: this.audit,
      environment: this.environment,
      operatorAuthority: new PrincipalSupportAuthority(principal),
      repository: this.repository,
    });
  }
}

class PrincipalSupportAuthority implements SupportOperatorAuthorityPort {
  public constructor(private readonly principal: AdminPrincipal) {}

  public async authorize() {
    return hasAdminCapability(this.principal, "SUPPORT_MANAGE")
      ? {
          operatorReference: this.principal.adminId,
          status: "AUTHORIZED" as const,
        }
      : { status: "DENIED" as const };
  }
}

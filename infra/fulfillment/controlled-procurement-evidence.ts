import { supplierId } from "../../packages/platform/src/contracts.js";
import type {
  FulfillmentProcurementEvidence,
  FulfillmentProcurementEvidencePort,
} from "../../packages/platform/src/fulfillment/secure-key-fulfillment.js";
import type { ControlledProcurementApprovalRepository } from "../suppliers/kinguin/kinguin-controlled-live-procurement.js";

export class ControlledProcurementFulfillmentEvidence implements FulfillmentProcurementEvidencePort {
  public constructor(
    private readonly approvals: ControlledProcurementApprovalRepository,
  ) {}

  public async getControlledProcurementEvidence(
    approvalId: string,
  ): Promise<FulfillmentProcurementEvidence> {
    const approval = await this.approvals.findById(approvalId);
    if (!approval) {
      return { status: "NOT_FOUND" };
    }
    if (
      approval.status !== "PROCUREMENT_CONFIRMED" ||
      approval.dispatchState !== "DISPATCH_CONFIRMED"
    ) {
      return {
        controlledProcurementApprovalId: approval.approvalId,
        status: "UNCONFIRMED",
      };
    }
    return {
      controlledProcurementApprovalId: approval.approvalId,
      expectedQuantity: approval.quantity,
      externalSupplierOrderId: approval.externalSupplierOrderId ?? null,
      status: "CONFIRMED",
      supplierId: supplierId(approval.supplierId),
      supplierItemReference: approval.supplierOfferId,
    };
  }
}

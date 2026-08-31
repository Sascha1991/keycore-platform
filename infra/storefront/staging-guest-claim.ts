import {
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  PersistedGuestOrderClaimAuthority,
  type CustomerEmailVerificationDeliveryPort,
} from "../../packages/platform/src/contracts.js";
import type { TransactionalQueryable } from "../postgres/client.js";
import { PostgresCustomerOrderIdentityRepository } from "../postgres/customer-order-identity-repositories.js";
import { PostgresCustomerRegistrationChallengeRepository } from "../postgres/customer-registration-repositories.js";
import { PostgresGuestOrderClaimRepository } from "../postgres/guest-order-claim-repositories.js";
import { PostgresAuditEventRepository } from "../postgres/repositories.js";
import type { StagingGuestOrderClaimPort } from "./staging-browser-adapter.js";

export const createPostgresStagingGuestOrderClaim = (
  database: TransactionalQueryable,
): StagingGuestOrderClaimPort => {
  const audit = new PostgresAuditEventRepository(database);
  const identityRepository = new PostgresCustomerOrderIdentityRepository(
    database,
  );
  const service = new CustomerRegistrationService({
    audit,
    challengeRepository: new PostgresCustomerRegistrationChallengeRepository(
      database,
    ),
    claimAuthority: new PersistedGuestOrderClaimAuthority({
      repository: new PostgresGuestOrderClaimRepository(database),
    }),
    delivery: new UnavailableVerificationDelivery(),
    environment: "STAGING",
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      audit,
      environment: "STAGING",
      repository: identityRepository,
    }),
  });

  return {
    claimGuestOrder: (input) => service.claimGuestOrder(input),
  };
};

class UnavailableVerificationDelivery implements CustomerEmailVerificationDeliveryPort {
  public async sendVerificationChallenge(): Promise<{
    readonly status: "FAILED";
  }> {
    return { status: "FAILED" };
  }
}

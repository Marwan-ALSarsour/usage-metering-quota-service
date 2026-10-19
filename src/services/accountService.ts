import { db } from '../db';
import { accounts } from '../db/schema/accounts';
import { plans } from '../db/schema/plans';
import { isNonEmptyString, isValidUuid } from '../utils/validation';
import { generateApiKey, hashApiKey } from '../utils/crypto';
import { eq } from 'drizzle-orm';

export class AccountCreationError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AccountCreationError';
    this.status = status;
    this.code = code;
  }
}

export interface CreateAccountInput {
  name: unknown;
  planId: unknown;
}

export interface CreateAccountResult {
  id: string;
  name: string;
  planId: string;
  apiKey: string;
  createdAt: Date;
}

/**
 * Creates an account with an initial predefined ACCOUNT-scoped plan.
 * Used by both admin routes and demo account proxy.
 */
export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  const { name, planId } = input || {};

  if (!isNonEmptyString(name)) {
    throw new AccountCreationError(400, 'BAD_REQUEST', 'Account name must be a non-empty string');
  }

  if (!isValidUuid(planId)) {
    throw new AccountCreationError(400, 'BAD_REQUEST', 'Valid planId UUID is required');
  }

  // Verify the plan exists and is an ACCOUNT plan
  const planResult = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);

  if (planResult.length === 0) {
    throw new AccountCreationError(404, 'NOT_FOUND', 'Plan not found');
  }

  const plan = planResult[0];
  if (plan.scope !== 'ACCOUNT') {
    throw new AccountCreationError(
      400,
      'BAD_REQUEST',
      `Plan '${plan.name}' is a ${plan.scope} plan and cannot be assigned to an account`
    );
  }

  // Only predefined plans can be used on initial account creation
  if (plan.isCustom) {
    throw new AccountCreationError(
      400,
      'BAD_REQUEST',
      'Initial account plan must be a predefined account plan'
    );
  }

  const plaintextApiKey = generateApiKey();
  const apiKeyHash = hashApiKey(plaintextApiKey);

  const inserted = await db
    .insert(accounts)
    .values({
      name: name.trim(),
      planId: plan.id,
      apiKeyHash,
    })
    .returning();

  const createdAccount = inserted[0];

  return {
    id: createdAccount.id,
    name: createdAccount.name,
    planId: createdAccount.planId,
    apiKey: plaintextApiKey,
    createdAt: createdAccount.createdAt,
  };
}

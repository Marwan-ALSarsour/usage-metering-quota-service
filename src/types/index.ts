import type { Account } from '../db/schema/accounts';
import type { Plan } from '../db/schema/plans';

export interface AuthenticatedAccount extends Account {
  plan: Plan;
}

declare global {
  namespace Express {
    interface Request {
      account?: AuthenticatedAccount;
    }
  }
}

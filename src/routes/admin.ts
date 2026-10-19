import { Router, Request, Response, NextFunction } from 'express';
import { requireAdminAuth } from '../middleware/auth';
import { createAccount, AccountCreationError } from '../services/accountService';

export const adminRouter = Router();

/**
 * POST /api/v1/accounts
 * Admin-only: Creates a new account, assigns an initial ACCOUNT-scoped plan,
 * and issues a plaintext API key (returned only once).
 */
adminRouter.post(
  '/accounts',
  requireAdminAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await createAccount(req.body);
      res.status(201).json(result);
    } catch (error: any) {
      if (error instanceof AccountCreationError) {
        res.status(error.status).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  }
);

import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { hashApiKey } from '../utils/crypto';
import { db } from '../db';
import { accounts } from '../db/schema/accounts';
import { plans } from '../db/schema/plans';
import { eq } from 'drizzle-orm';

/**
 * Constant-time string comparison to prevent timing attacks on secret keys.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware ensuring the request contains a valid ADMIN_API_KEY.
 * Accepts X-Admin-Key header or Authorization: Bearer <key>.
 * Uses timing-safe string comparison.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKeyHeader = req.headers['x-admin-key'];
  const authHeader = req.headers['authorization'];

  let providedKey: string | undefined;

  if (typeof adminKeyHeader === 'string') {
    providedKey = adminKeyHeader.trim();
  } else if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim();
  }

  if (!providedKey) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing admin API key in X-Admin-Key or Authorization header',
    });
    return;
  }

  if (!timingSafeEqualStr(providedKey, env.ADMIN_API_KEY)) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid admin API key',
    });
    return;
  }

  next();
}

/**
 * Middleware ensuring the request contains a valid account API key.
 * Accepts X-API-Key header or Authorization: Bearer <key>.
 * Looks up the account by SHA-256 hash and attaches account & plan to req.account.
 */
export async function requireAccountAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  let rawApiKey: string | undefined;

  if (typeof apiKeyHeader === 'string') {
    rawApiKey = apiKeyHeader.trim();
  } else if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    rawApiKey = authHeader.slice(7).trim();
  }

  if (!rawApiKey) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing account API key in X-API-Key or Authorization header',
    });
    return;
  }

  const keyHash = hashApiKey(rawApiKey);

  try {
    const result = await db
      .select({
        account: accounts,
        plan: plans,
      })
      .from(accounts)
      .innerJoin(plans, eq(accounts.planId, plans.id))
      .where(eq(accounts.apiKeyHash, keyHash))
      .limit(1);

    if (result.length === 0) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid account API key',
      });
      return;
    }

    req.account = {
      ...result[0].account,
      plan: result[0].plan,
    };

    next();
  } catch (error: any) {
    next(error);
  }
}

import { pgTable, uuid, varchar, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';

export const accountMonthlyUsage = pgTable(
  'account_monthly_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .references(() => accounts.id, { onDelete: 'cascade' })
      .notNull(),
    period: varchar('period', { length: 7 }).notNull(), // 'YYYY-MM'
    unitsUsed: integer('units_used').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('account_monthly_usage_period_idx').on(table.accountId, table.period),
    index('account_monthly_usage_account_idx').on(table.accountId),
  ]
);

export const userMonthlyUsage = pgTable(
  'user_monthly_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    accountId: uuid('account_id')
      .references(() => accounts.id, { onDelete: 'cascade' })
      .notNull(),
    period: varchar('period', { length: 7 }).notNull(), // 'YYYY-MM'
    unitsUsed: integer('units_used').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_monthly_usage_period_idx').on(table.userId, table.period),
    index('user_monthly_usage_account_period_idx').on(table.accountId, table.period),
  ]
);

export type AccountMonthlyUsage = typeof accountMonthlyUsage.$inferSelect;
export type NewAccountMonthlyUsage = typeof accountMonthlyUsage.$inferInsert;

export type UserMonthlyUsage = typeof userMonthlyUsage.$inferSelect;
export type NewUserMonthlyUsage = typeof userMonthlyUsage.$inferInsert;

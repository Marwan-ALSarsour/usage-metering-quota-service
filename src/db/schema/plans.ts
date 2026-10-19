import { pgTable, uuid, varchar, integer, boolean, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accounts } from './accounts';

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    scope: varchar('scope', { length: 20 }).notNull(), // 'ACCOUNT' | 'USER'
    monthlyAllowance: integer('monthly_allowance').notNull(),
    maxUnitsPerRequest: integer('max_units_per_request').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('unique_predefined_plan_idx')
      .on(table.scope, table.name)
      .where(sql`${table.accountId} IS NULL`),
    uniqueIndex('unique_custom_plan_idx')
      .on(table.scope, table.accountId, table.name)
      .where(sql`${table.accountId} IS NOT NULL`),
  ]
);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

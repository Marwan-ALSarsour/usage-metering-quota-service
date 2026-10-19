import { pgTable, uuid, varchar, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { plans } from './plans';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    apiKeyHash: varchar('api_key_hash', { length: 64 }).notNull(),
    planId: uuid('plan_id')
      .references((): AnyPgColumn => plans.id, { onDelete: 'restrict' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('accounts_api_key_hash_idx').on(table.apiKeyHash),
  ]
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

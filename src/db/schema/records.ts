import { pgTable, uuid, varchar, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { users } from './users';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .references(() => accounts.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    clientRequestId: varchar('client_request_id', { length: 255 }).notNull(),
    unitsRequested: integer('units_requested').notNull(),
    unitsConsumed: integer('units_consumed').notNull().default(0),
    status: varchar('status', { length: 20 }).notNull(), // 'ACCEPTED' | 'REJECTED'
    rejectionReason: varchar('rejection_reason', { length: 100 }), // null if ACCEPTED
    period: varchar('period', { length: 7 }).notNull(), // 'YYYY-MM'
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('usage_records_account_req_id_idx').on(table.accountId, table.clientRequestId),
    index('usage_records_account_created_at_idx').on(table.accountId, table.createdAt),
    index('usage_records_account_period_idx').on(table.accountId, table.period),
    index('usage_records_user_period_idx').on(table.userId, table.period),
  ]
);

export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;

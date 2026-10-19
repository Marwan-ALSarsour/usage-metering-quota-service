import { db, queryClient } from './index';
import { plans } from './schema/plans';
import { eq, and, isNull } from 'drizzle-orm';

export const PREDEFINED_PLANS = [
  {
    name: 'Starter',
    scope: 'ACCOUNT',
    monthlyAllowance: 10000,
    maxUnitsPerRequest: 500,
    isCustom: false,
    accountId: null,
  },
  {
    name: 'Pro',
    scope: 'ACCOUNT',
    monthlyAllowance: 100000,
    maxUnitsPerRequest: 5000,
    isCustom: false,
    accountId: null,
  },
  {
    name: 'Basic',
    scope: 'USER',
    monthlyAllowance: 1000,
    maxUnitsPerRequest: 100,
    isCustom: false,
    accountId: null,
  },
  {
    name: 'Premium',
    scope: 'USER',
    monthlyAllowance: 10000,
    maxUnitsPerRequest: 1000,
    isCustom: false,
    accountId: null,
  },
] as const;

export async function seedPredefinedPlans() {
  console.log('Seeding predefined plans...');
  for (const plan of PREDEFINED_PLANS) {
    const existing = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.name, plan.name),
          eq(plans.scope, plan.scope),
          isNull(plans.accountId)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(plans).values(plan);
      console.log(`Seeded plan: ${plan.name} (${plan.scope})`);
    } else {
      console.log(`Plan already exists: ${plan.name} (${plan.scope})`);
    }
  }
  console.log('Predefined plans seeding complete.');
}

if (require.main === module) {
  seedPredefinedPlans()
    .then(async () => {
      await queryClient.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seeding failed:', err);
      await queryClient.end();
      process.exit(1);
    });
}

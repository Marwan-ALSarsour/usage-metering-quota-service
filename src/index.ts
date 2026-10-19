import { createApp } from './app';
import { env } from './config/env';
import { queryClient } from './db';
import { runMigrations } from './db/migrate';
import { seedPredefinedPlans } from './db/seed';

async function main() {
  // Run migrations and seed idempotently before accepting traffic.
  // Both operations are safe to re-run against an already up-to-date database.
  await runMigrations();
  await seedPredefinedPlans();

  const app = createApp();

  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`Usage Metering Service listening on http://${env.HOST}:${env.PORT}`);
  });

  async function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      console.log('HTTP server closed.');
      try {
        await queryClient.end();
        console.log('Database connection pool closed.');
        process.exit(0);
      } catch (err) {
        console.error('Error closing database connections:', err);
        process.exit(1);
      }
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(async (err) => {
  console.error('Fatal startup error:', err);
  await queryClient.end().catch(() => {});
  process.exit(1);
});

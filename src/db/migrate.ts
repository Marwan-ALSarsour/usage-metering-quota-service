import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from './index';
import path from 'path';
import fs from 'fs';

export async function runMigrations() {
  console.log('Running database migrations...');
  const candidateFolders = [
    path.resolve(__dirname, 'migrations'),
    path.resolve(__dirname, '../../../src/db/migrations'),
    path.resolve(__dirname, '../../src/db/migrations'),
    path.resolve(process.cwd(), 'dist/src/db/migrations'),
    path.resolve(process.cwd(), 'src/db/migrations'),
  ];

  const migrationsFolder = candidateFolders.find((folder) =>
    fs.existsSync(path.join(folder, 'meta', '_journal.json'))
  );

  if (!migrationsFolder) {
    throw new Error(
      `Migrations folder with meta/_journal.json not found in candidate paths: ${candidateFolders.join(', ')}`
    );
  }

  await migrate(db, { migrationsFolder });
  console.log('Migrations completed successfully.');
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      await queryClient.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await queryClient.end();
      process.exit(1);
    });
}

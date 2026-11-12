import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expectedStage, openDatabase } from '../src/db/runtime.mjs';

const stage = expectedStage();
const sql = openDatabase(process.env.DATABASE_MIGRATION_URL);
try {
  // Keep the session lock and the migration on the same connection.
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(72036592)`;
    await connection`CREATE TABLE IF NOT EXISTS app_environment (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      stage text NOT NULL CHECK (stage IN ('development','preview','production'))
    )`;
    await connection`INSERT INTO app_environment (stage) VALUES (${stage}) ON CONFLICT DO NOTHING`;
    const [environment] = await connection`SELECT stage FROM app_environment`;
    if (environment.stage !== stage) throw new Error('DATABASE_STAGE_MISMATCH');
    // Drizzle uses its own transaction, so use the direct migration pool while the lock is held.
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
    console.log('Migrations applied for '+stage);
  } finally {
    await connection`SELECT pg_advisory_unlock(72036592)`;
    connection.release();
  }
} finally {
  await sql.end();
}

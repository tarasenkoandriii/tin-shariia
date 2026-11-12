import postgres from 'postgres';

export function expectedStage() {
  const { APP_STAGE, VERCEL_ENV } = process.env;
  if (!['development', 'preview', 'production'].includes(APP_STAGE)
      || (VERCEL_ENV && VERCEL_ENV !== APP_STAGE)) {
    throw new Error('APP_STAGE_MISMATCH');
  }
  return APP_STAGE;
}

export function openDatabase(url) {
  if (!url) throw new Error('DATABASE_URL_REQUIRED');
  return postgres(url, { max: 3, prepare: false, idle_timeout: 20 });
}

function adapter(sql) {
  return { async query(statement, params = []) {
    return { rows: await sql.unsafe(statement, params) };
  } };
}

let pool;
export async function database() {
  const stage = expectedStage();
  pool ??= openDatabase(process.env.DATABASE_URL);
  const { rows: [environment] } = await adapter(pool).query('SELECT stage FROM app_environment');
  if (environment?.stage !== stage) throw new Error('DATABASE_STAGE_MISMATCH');
  return {
    ...adapter(pool),
    transaction: work => pool.begin(tx => work(adapter(tx))),
  };
}

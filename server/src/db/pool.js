import pg from 'pg';
import { config } from '../config.js';

// BIGINT ids come back as strings by default - ours fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

import { Pool } from 'pg';

console.log('🔍 DATABASE_URL:', process.env.DATABASE_URL ? 'SET (hidden)' : 'NOT SET');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: process.env.DATABASE_URL?.includes('supabase.co') 
    ? { rejectUnauthorized: false } 
    : false
});

export async function getDb() {
  return pool;
}

export async function initDb() {
  const client = await pool.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        github_id TEXT UNIQUE,
        username TEXT,
        email TEXT,
        avatar_url TEXT,
        name TEXT,
        bio TEXT,
        access_token TEXT,
        skill_graph JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        provider TEXT,
        provider_user_id TEXT,
        access_token TEXT,
        refresh_token TEXT,
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        stake_amount REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)`);

    console.log('✅ PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}
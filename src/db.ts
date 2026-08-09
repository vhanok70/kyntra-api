import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function getDb() {
  return open({
    filename: './kyntra.db',
    driver: sqlite3.Database
  });
}

export async function initDb() {
  const db = await getDb();
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id TEXT UNIQUE,
      username TEXT,
      email TEXT,
      avatar_url TEXT,
      name TEXT,
      bio TEXT,
      access_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      provider TEXT,
      provider_user_id TEXT,
      access_token TEXT,
      refresh_token TEXT,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, provider)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      stake_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)
  `);

  return db;
}
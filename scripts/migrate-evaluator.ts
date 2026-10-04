#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve('database/evaluator-migrations');
// Resolve the path based on env var or fallback
const DB_PATH = process.env.EVALUATOR_DB_PATH ? path.resolve(process.env.EVALUATOR_DB_PATH) : path.resolve('data/evaluator.db');

function main(): void {
  console.log(`Connecting to SQLite database at ${DB_PATH}`);
  
  // Ensure the directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);

  const appliedMigrations = new Set(
    (db.prepare('SELECT filename FROM migrations').all() as Array<{ filename: string }>).map((row) => row.filename)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const runMigration = db.transaction((file: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(file);
  });

  let count = 0;
  for (const file of files) {
    if (appliedMigrations.has(file)) {
      continue;
    }

    console.log(`Applying migration: ${file}`);
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = readFileSync(filePath, 'utf8');

    try {
      runMigration(file, sql);
      count++;
    } catch (err) {
      console.error(`Failed to apply migration ${file}:`, err);
      process.exit(1);
    }
  }

  console.log(`Successfully applied ${count} migrations.`);
  db.close();
}

main();

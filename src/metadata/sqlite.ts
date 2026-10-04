import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import type { Logger } from '../utils/logger.js';

let dbInstance: Database.Database | null = null;

export function getEvaluatorDb(logger?: Logger): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = process.env.EVALUATOR_DB_PATH ? path.resolve(process.env.EVALUATOR_DB_PATH) : path.resolve('data/evaluator.db');
  
  if (logger) {
    logger.info({ dbPath }, 'Opening SQLite metadata database');
  }
  
  const parent = path.dirname(dbPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5 seconds when DB is locked
  applyMigrations(db, logger);

  dbInstance = db;
  return dbInstance;
}

function applyMigrations(db: Database.Database, logger?: Logger): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const migrationDir = path.resolve('database/evaluator-migrations');
  const applied = new Set(
    db.prepare('SELECT filename FROM migrations').all().map((row) => (row as { filename: string }).filename),
  );
  const migrate = db.transaction((filename: string, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(filename);
  });
  for (const filename of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    if (applied.has(filename)) continue;
    migrate(filename, readFileSync(path.join(migrationDir, filename), 'utf8'));
    logger?.info({ filename }, 'Applied evaluator migration');
  }
}

export function closeEvaluatorDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

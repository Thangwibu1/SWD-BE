import Database from 'better-sqlite3';
import path from 'node:path';
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
  
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // Wait up to 5 seconds when DB is locked

  dbInstance = db;
  return dbInstance;
}

export function closeEvaluatorDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

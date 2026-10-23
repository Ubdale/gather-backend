import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly connection: DatabaseSync;
  constructor() {
    const file = process.env.DATABASE_PATH || '.data/gather.sqlite';
    if (file !== ':memory:')
      mkdirSync(dirname(resolve(file)), { recursive: true });
    this.connection = new DatabaseSync(file);
    this.connection
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recoveries(hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT 'A place for your people.', accent TEXT NOT NULL DEFAULT '#247461', owner_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL DEFAULT 'trial', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS memberships(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','moderator','member')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')), PRIMARY KEY(workspace_id,user_id));
      CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','moderator','member')), expires INTEGER NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS spaces(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id,name));
      CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), space_id INTEGER NOT NULL REFERENCES spaces(id), user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT);
      CREATE INDEX IF NOT EXISTS posts_workspace ON posts(workspace_id,id);
      CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS reactions(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(post_id,user_id));
      CREATE TABLE IF NOT EXISTS bookmarks(post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(post_id,user_id));
      CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS participants(conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), last_read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
      CREATE TABLE IF NOT EXISTS voice_messages(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, audio BLOB NOT NULL, mime TEXT NOT NULL, duration REAL NOT NULL, waveform TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE UNIQUE INDEX IF NOT EXISTS open_report ON reports(post_id,user_id) WHERE status='open';
      CREATE TABLE IF NOT EXISTS plan_requests(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      PRAGMA user_version=1;`);
  }
  get(sql: string, ...params: SQLInputValue[]): any {
    return this.connection.prepare(sql).get(...params);
  }
  all(sql: string, ...params: SQLInputValue[]): any[] {
    return this.connection.prepare(sql).all(...params);
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params);
  }
  transaction<T>(work: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
  log(workspace: number, user: number, action: string) {
    this.run(
      'INSERT INTO audit(workspace_id,user_id,action) VALUES(?,?,?)',
      workspace,
      user,
      action,
    );
  }
  onModuleDestroy() {
    this.connection.close();
  }
}

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError, normalizeError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } = require('./migrations');

/**
 * @returns {typeof import('node:sqlite')}
 */
function loadSqlite() {
  try {
    // eslint-disable-next-line global-require
    return require('node:sqlite');
  } catch (error) {
    throw new AppError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      '当前运行时没有可用的 node:sqlite。请使用 Node >= 22.13 或 VS Code 内置 Node 运行 CLI。',
      { cause: error, retryable: true }
    );
  }
}

class SqliteDatabase {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, '数据库路径必须是绝对路径。');
    }
    this.filePath = filePath;
    this.db = null;
    this.version = 0;
  }

  /**
   * 打开数据库、设置连接级 PRAGMA 并执行迁移。
   * @returns {Promise<void>}
   */
  async open() {
    if (this.db) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    try {
      this.db = new DatabaseSync(this.filePath);
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA journal_mode = DELETE');
      this.version = this.getUserVersion();
      await this.migrate();
    } catch (error) {
      if (this.db) {
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
      throw normalizeError(error);
    }
  }

  /**
   * @returns {number}
   */
  getUserVersion() {
    const row = this.db.prepare('PRAGMA user_version').get();
    return Number(row.user_version) || 0;
  }

  /**
   * @returns {Promise<void>}
   */
  async migrate() {
    if (this.version > SUPPORTED_SCHEMA_VERSION) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `数据库 schema 版本 ${this.version} 高于当前插件支持的 ${SUPPORTED_SCHEMA_VERSION}，请升级扩展。`,
        { details: { databaseVersion: this.version, supportedVersion: SUPPORTED_SCHEMA_VERSION } }
      );
    }
    if (this.version === SUPPORTED_SCHEMA_VERSION) return;

    if (this.version > 0) {
      await this.backup(`before-migration-v${this.version}`);
    }

    const pending = MIGRATIONS.filter((migration) => migration.version > this.version)
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of migration.statements) this.db.exec(statement);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
        this.version = migration.version;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw new AppError(
          ERROR_CODES.INTERNAL_ERROR,
          `数据库迁移到版本 ${migration.version} 失败：${error.message}`,
          { cause: error }
        );
      }
    }
    const check = this.quickCheck();
    if (!check.ok) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `数据库完整性检查失败：${check.messages.join('; ')}`);
    }
  }

  /**
   * @param {string} [tag]
   * @returns {Promise<string>}
   */
  async backup(tag = 'manual') {
    if (!this.db) throw new AppError(ERROR_CODES.INTERNAL_ERROR, '数据库尚未打开。');
    const dir = path.join(path.dirname(this.filePath), 'backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `pm-${tag}-${stamp}.sqlite`);
    try {
      this.db.exec('PRAGMA optimize');
      await fs.copyFile(this.filePath, target);
    } catch (error) {
      throw normalizeError(error);
    }
    return target;
  }

  /**
   * @returns {{ok: boolean, messages: string[]}}
   */
  quickCheck() {
    try {
      const rows = this.db.prepare('PRAGMA quick_check').all();
      const messages = rows.map((row) => Object.values(row)[0]).filter((value) => value !== 'ok');
      return { ok: messages.length === 0, messages };
    } catch (error) {
      return { ok: false, messages: [normalizeError(error).message] };
    }
  }

  /**
   * @returns {string}
   */
  sqliteVersion() {
    try {
      return String(this.db.prepare('SELECT sqlite_version() AS version').get().version);
    } catch {
      return 'unknown';
    }
  }

  /**
   * 同步事务：回调必须是同步函数，避免在持锁期间 await 文件系统。
   * @param {() => T} callback
   * @returns {T}
   * @template T
   */
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, '数据库事务回调不能是异步函数。');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {import('node:sqlite').StatementResultingChanges}
   */
  run(sql, params = []) {
    try {
      return this.db.prepare(sql).run(...params);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {unknown}
   */
  get(sql, params = []) {
    try {
      return this.db.prepare(sql).get(...params);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {unknown[]}
   */
  all(sql, params = []) {
    try {
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} sql
   */
  exec(sql) {
    try {
      this.db.exec(sql);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
  }
}

module.exports = {
  SqliteDatabase,
  loadSqlite
};

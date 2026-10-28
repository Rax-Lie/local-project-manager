'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SqliteDatabase, loadSqlite } = require('../../src/adapters/sqlite/database');
const { makeTempDir, removeAll } = require('../helpers/temp');

test('SQLite schema v1、外键和完整性检查可用', async (t) => {
  const temp = await makeTempDir();
  t.after(() => removeAll([temp]));
  const db = new SqliteDatabase(path.join(temp, 'pm.sqlite'));
  await db.open();
  assert.equal(db.version, 1);
  assert.equal(db.quickCheck().ok, true);
  assert.match(db.sqliteVersion(), /^\d+\.\d+/);
  const foreignKeys = db.get('PRAGMA foreign_keys');
  assert.equal(Number(foreignKeys.foreign_keys), 1);
  assert.throws(() => db.run(
    'INSERT INTO projects (project_id, root_id, template_id) VALUES (?, ?, ?)',
    ['prj_x', 'root_x', 'missing']
  ), (error) => error.code === 'INTERNAL_ERROR' || error.code === 'CONFLICT');
  db.close();
});

test('未来 schema 版本被拒绝且原数据库保留', async (t) => {
  const temp = await makeTempDir();
  t.after(() => removeAll([temp]));
  const dbPath = path.join(temp, 'pm.sqlite');
  const first = new SqliteDatabase(dbPath);
  await first.open();
  first.exec('PRAGMA user_version = 99');
  first.close();
  const before = (await fs.stat(dbPath)).size;

  const future = new SqliteDatabase(dbPath);
  await assert.rejects(future.open(), (error) => error.code === 'VALIDATION_FAILED');
  future.close();
  assert.ok((await fs.stat(dbPath)).size >= before);
});

test('数据库唯一约束冲突转换为 CONFLICT', async (t) => {
  const temp = await makeTempDir();
  t.after(() => removeAll([temp]));
  const db = new SqliteDatabase(path.join(temp, 'pm.sqlite'));
  await db.open();
  db.run(
    `INSERT INTO templates (root_id, id, revision, relative_path, enabled, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    ['root_r', 'tpl', 1, '.pm/templates/tpl.json', new Date().toISOString()]
  );
  const insert = () => db.run(
    `INSERT INTO projects (
      project_id, root_id, template_id, template_revision, slug, display_name,
      relative_path, status, field_values, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['prj_a', 'root_r', 'tpl', 1, 'demo', 'Demo', 'projects/demo', 'provisioning', '{}',
      new Date().toISOString(), new Date().toISOString()]
  );
  insert();
  assert.throws(insert, (error) => error.code === 'CONFLICT');
  db.close();
});

test('loadSqlite 在支持的环境返回 DatabaseSync', () => {
  const sqlite = loadSqlite();
  assert.equal(typeof sqlite.DatabaseSync, 'function');
});

'use strict';

/**
 * schema 版本只增不减。迁移语句在单个事务中执行，user_version 最后写入。
 * 修改任何已有语句会破坏已发布数据库的可升级性。
 */
const MIGRATIONS = Object.freeze([
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS templates (
        root_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (root_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_revision INTEGER NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('provisioning','active','archiving','archived','needs_recovery')),
        field_values TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (root_id, slug),
        UNIQUE (root_id, relative_path),
        FOREIGN KEY (root_id, template_id) REFERENCES templates(root_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_projects_root_created
        ON projects(root_id, created_at DESC, project_id ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_projects_root_status
        ON projects(root_id, status)`,
      `CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned','applying','awaiting_workspace','completed','needs_recovery','undone')),
        project_id TEXT,
        source_relative_path TEXT,
        target_relative_path TEXT,
        completed_steps TEXT NOT NULL DEFAULT '[]',
        inverse_plan_version INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_operations_root_state
        ON operations(root_id, state)`
    ]
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS staging_suggestions (
        root_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        scan_root TEXT NOT NULL,
        source_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
        reasons TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending','ignored','accepted')),
        project_id TEXT,
        scanned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (root_id, candidate_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_staging_root_decision
        ON staging_suggestions(root_id, decision, score DESC)`
    ]
  }
]);

const SUPPORTED_SCHEMA_VERSION = 2;

module.exports = {
  MIGRATIONS,
  SUPPORTED_SCHEMA_VERSION
};

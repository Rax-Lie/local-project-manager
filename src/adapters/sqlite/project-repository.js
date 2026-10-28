'use strict';

const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { projectSummary } = require('../../domain/project');
const {
  normalizeSearchQuery,
  searchDigest,
  escapeLike,
  encodeCursor,
  decodeCursor
} = require('./search-query');

class ProjectRepository {
  /**
   * @param {import('./database').SqliteDatabase} database
   */
  constructor(database) {
    this.db = database;
  }

  /**
   * @param {string} projectId
   * @returns {Promise<object|null>}
   */
  async getById(projectId) {
    const row = this.db.get('SELECT * FROM projects WHERE project_id = ?', [projectId]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * @param {string} rootId
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async getBySlug(rootId, slug) {
    const row = this.db.get('SELECT * FROM projects WHERE root_id = ? AND slug = ?', [rootId, slug]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * @param {string} rootId
   * @param {string} relativePath
   * @returns {Promise<object|null>}
   */
  async getByRelativePath(rootId, relativePath) {
    const row = this.db.get(
      'SELECT * FROM projects WHERE root_id = ? AND relative_path = ? COLLATE NOCASE',
      [rootId, relativePath]
    );
    return row ? this.mapRow(row) : null;
  }

  /**
   * @param {string} rootId
   * @returns {Promise<object[]>}
   */
  async listForRoot(rootId) {
    const rows = this.db.all(
      'SELECT * FROM projects WHERE root_id = ? ORDER BY created_at DESC, project_id ASC LIMIT 1000',
      [rootId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * @param {{rootId: string, text?: string, status?: string, fieldFilters?: Array<object>, cursor?: string, limit?: number}} query
   * @returns {Promise<{items: object[], nextCursor?: string}>}
   */
  async search(query) {
    const normalized = normalizeSearchQuery(query);
    const digest = searchDigest(normalized);
    const clauses = ['root_id = ?'];
    const params = [normalized.rootId];

    if (normalized.status) {
      clauses.push('status = ?');
      params.push(normalized.status);
    }
    if (normalized.text) {
      const pattern = `%${escapeLike(normalized.text)}%`;
      clauses.push("(display_name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    for (const filter of normalized.fieldFilters) {
      const path = `$."${filter.fieldId}"`;
      if (filter.operator === 'contains') {
        clauses.push("CAST(json_extract(field_values, ?) AS TEXT) LIKE ? ESCAPE '\\'");
        params.push(path, `%${escapeLike(String(filter.value))}%`);
      } else if (filter.value === null) {
        clauses.push('json_extract(field_values, ?) IS NULL');
        params.push(path);
      } else {
        clauses.push('json_extract(field_values, ?) = ?');
        params.push(path, filter.value);
      }
    }

    if (normalized.cursor) {
      const cursor = decodeCursor(normalized.cursor, digest);
      clauses.push('(created_at < ? OR (created_at = ? AND project_id > ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.projectId);
    }

    params.push(normalized.limit + 1);
    const sql = `SELECT * FROM projects WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, project_id ASC LIMIT ?`;
    const rows = this.db.all(sql, params);
    const hasMore = rows.length > normalized.limit;
    const pageRows = hasMore ? rows.slice(0, normalized.limit) : rows;
    const items = pageRows.map((row) => projectSummary(this.mapRow(row)));
    const result = { items };
    if (hasMore && items.length > 0) {
      const last = pageRows[pageRows.length - 1];
      result.nextCursor = encodeCursor({ digest, createdAt: last.created_at, projectId: last.project_id });
    }
    return result;
  }

  /**
   * @param {object} record
   * @returns {Promise<void>}
   */
  async insert(record) {
    this.db.run(
      `INSERT INTO projects (
        project_id, root_id, template_id, template_revision, slug, display_name,
        relative_path, status, field_values, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.projectId,
        record.rootId,
        record.templateId,
        record.templateRevision,
        record.slug,
        record.displayName,
        record.relativePath,
        record.status,
        JSON.stringify(record.fieldValues),
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  /**
   * @param {object} record
   * @param {string} expectedUpdatedAt
   * @returns {Promise<void>}
   */
  async update(record, expectedUpdatedAt) {
    const changes = this.db.run(
      `UPDATE projects SET
        template_id = ?, template_revision = ?, slug = ?, display_name = ?,
        relative_path = ?, status = ?, field_values = ?, updated_at = ?
       WHERE project_id = ? AND updated_at = ?`,
      [
        record.templateId,
        record.templateRevision,
        record.slug,
        record.displayName,
        record.relativePath,
        record.status,
        JSON.stringify(record.fieldValues),
        record.updatedAt,
        record.projectId,
        expectedUpdatedAt
      ]
    ).changes;
    if (changes === 0) {
      const current = await this.getById(record.projectId);
      if (!current) {
        throw new AppError(ERROR_CODES.CONFLICT, `项目不存在：${record.projectId}`);
      }
      throw new AppError(ERROR_CODES.CONFLICT, '项目记录已被其他操作修改，请刷新后重试。', {
        details: { projectId: record.projectId }
      });
    }
  }

  /**
   * @param {object} query
   * @param {object} row
   * @returns {object}
   */
  mapRow(row) {
    let fieldValues;
    try {
      fieldValues = JSON.parse(row.field_values);
    } catch {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `项目 ${row.project_id} 的 fieldValues 已损坏。`);
    }
    return {
      projectId: row.project_id,
      rootId: row.root_id,
      templateId: row.template_id,
      templateRevision: row.template_revision,
      slug: row.slug,
      displayName: row.display_name,
      relativePath: row.relative_path,
      status: row.status,
      fieldValues,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = {
  ProjectRepository
};

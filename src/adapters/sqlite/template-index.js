'use strict';

class TemplateIndex {
  /**
   * @param {import('./database').SqliteDatabase} database
   */
  constructor(database) {
    this.db = database;
  }

  /**
   * 模板 JSON 是内容真相，此表只是可重建索引。
   * @param {string} rootId
   * @param {Array<{template: object, relativePath: string}>} entries
   * @returns {Promise<void>}
   */
  async sync(rootId, entries) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const ids = [];
      for (const entry of entries) {
        const { template, relativePath } = entry;
        ids.push(template.id);
        this.db.run(
          `INSERT INTO templates (root_id, id, revision, relative_path, enabled, updated_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(root_id, id) DO UPDATE SET
             revision = excluded.revision,
             relative_path = excluded.relative_path,
             enabled = 1,
             updated_at = excluded.updated_at`,
          [rootId, template.id, template.revision, relativePath, now]
        );
      }
      const rows = this.db.all('SELECT id FROM templates WHERE root_id = ?', [rootId]);
      for (const row of rows) {
        if (!ids.includes(row.id)) {
          this.db.run(
            'UPDATE templates SET enabled = 0, updated_at = ? WHERE root_id = ? AND id = ?',
            [now, rootId, row.id]
          );
        }
      }
    });
  }

  /**
   * @param {string} rootId
   * @returns {Promise<object[]>}
   */
  async listEnabled(rootId) {
    return this.db.all(
      'SELECT id, revision, relative_path, updated_at FROM templates WHERE root_id = ? AND enabled = 1 ORDER BY id ASC',
      [rootId]
    );
  }
}

module.exports = {
  TemplateIndex
};

'use strict';

class StagingIndex {
  constructor(database) {
    this.db = database;
  }

  upsertScan(rootId, scanRoot, candidates, scannedAt) {
    this.db.transaction(() => {
      for (const item of candidates) {
        this.db.run(`INSERT INTO staging_suggestions (
          root_id, candidate_id, scan_root, source_path, display_name, score, reasons,
          decision, project_id, scanned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
        ON CONFLICT(root_id, candidate_id) DO UPDATE SET
          scan_root = excluded.scan_root, source_path = excluded.source_path,
          display_name = excluded.display_name, score = excluded.score,
          reasons = excluded.reasons, scanned_at = excluded.scanned_at,
          updated_at = excluded.updated_at
        WHERE staging_suggestions.decision = 'pending'`, [
          rootId, item.candidateId, scanRoot, item.sourcePath, item.displayName,
          item.score, JSON.stringify(item.reasons), scannedAt, scannedAt
        ]);
      }
      const ids = candidates.map((item) => item.candidateId);
      if (ids.length === 0) {
        this.db.run("DELETE FROM staging_suggestions WHERE root_id = ? AND scan_root = ? AND decision = 'pending'", [rootId, scanRoot]);
      } else {
        const slots = ids.map(() => '?').join(', ');
        this.db.run(
          `DELETE FROM staging_suggestions WHERE root_id = ? AND scan_root = ? AND decision = 'pending'
           AND candidate_id NOT IN (${slots})`, [rootId, scanRoot, ...ids]
        );
      }
    });
  }

  listPending(rootId, scanRoot) {
    return this.db.all(
      `SELECT * FROM staging_suggestions WHERE root_id = ? AND scan_root = ? AND decision = 'pending'
       ORDER BY score DESC, display_name COLLATE NOCASE, candidate_id`,
      [rootId, scanRoot]
    ).map((row) => this.mapRow(row));
  }

  decide(rootId, candidateId, decision, projectId, updatedAt) {
    const current = this.db.get(
      'SELECT decision, project_id FROM staging_suggestions WHERE root_id = ? AND candidate_id = ?',
      [rootId, candidateId]
    );
    if (!current) return false;
    if (current.decision !== 'pending') {
      return current.decision === decision && current.project_id === projectId;
    }
    const result = this.db.run(
      `UPDATE staging_suggestions SET decision = ?, project_id = ?, updated_at = ?
       WHERE root_id = ? AND candidate_id = ? AND decision = 'pending'`,
      [decision, projectId || null, updatedAt, rootId, candidateId]
    );
    return result.changes === 1;
  }

  mapRow(row) {
    return {
      candidateId: row.candidate_id,
      sourcePath: row.source_path,
      displayName: row.display_name,
      score: row.score,
      reasons: JSON.parse(row.reasons),
      decision: row.decision,
      projectId: row.project_id,
      scannedAt: row.scanned_at
    };
  }
}

module.exports = { StagingIndex };

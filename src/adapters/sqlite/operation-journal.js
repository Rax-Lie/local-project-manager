'use strict';

const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { assertOperationTransition, isIncompleteState, validateOperationRecord } = require('../../domain/operation');

class OperationJournal {
  /**
   * @param {import('./database').SqliteDatabase} database
   */
  constructor(database) {
    this.db = database;
  }

  /**
   * 幂等登记操作；已存在且类型一致的记录直接返回。
   * @param {object} record
   * @returns {Promise<object>}
   */
  async begin(record) {
    validateOperationRecord(record);
    const existing = await this.get(record.operationId);
    if (existing) {
      if (existing.kind !== record.kind) {
        throw new AppError(ERROR_CODES.CONFLICT, `操作 ID 已被其他类型占用：${record.operationId}`);
      }
      return existing;
    }
    try {
      this.db.run(
        `INSERT INTO operations (
          operation_id, root_id, kind, state, project_id, source_relative_path,
          target_relative_path, completed_steps, inverse_plan_version, payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.operationId,
          record.rootId,
          record.kind,
          record.state,
          record.projectId || null,
          record.sourceRelativePath || null,
          record.targetRelativePath || null,
          JSON.stringify(record.completedSteps),
          record.inversePlanVersion,
          JSON.stringify(record.payload || {}),
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      const raced = await this.get(record.operationId);
      if (raced && raced.kind === record.kind) return raced;
      throw error;
    }
    return this.get(record.operationId);
  }

  /**
   * @param {string} operationId
   * @returns {Promise<object|null>}
   */
  async get(operationId) {
    const row = this.db.get('SELECT * FROM operations WHERE operation_id = ?', [operationId]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * @param {string} rootId
   * @returns {Promise<object[]>}
   */
  async listIncomplete(rootId) {
    const rows = this.db.all(
      `SELECT * FROM operations
       WHERE root_id = ? AND state IN ('applying','awaiting_workspace','needs_recovery')
       ORDER BY created_at ASC, operation_id ASC`,
      [rootId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * @param {string} rootId
   * @returns {Promise<object[]>}
   */
  async listByRoot(rootId) {
    const rows = this.db.all(
      'SELECT * FROM operations WHERE root_id = ? ORDER BY created_at DESC, operation_id ASC LIMIT 1000',
      [rootId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * @param {string} operationId
   * @param {string} expectedState
   * @param {string} nextState
   * @param {{projectId?: string, sourceRelativePath?: string, targetRelativePath?: string, completedSteps?: string[], payload?: object, inversePlanVersion?: number}} [patch]
   * @returns {Promise<object>}
   */
  async transition(operationId, expectedState, nextState, patch = {}) {
    const current = await this.get(operationId);
    if (!current) {
      throw new AppError(ERROR_CODES.CONFLICT, `操作不存在：${operationId}`);
    }
    if (current.state === nextState) return current;
    if (current.state !== expectedState) {
      throw new AppError(
        ERROR_CODES.OPERATION_INCOMPLETE,
        `操作 ${operationId} 当前状态为 ${current.state}，预期 ${expectedState}。`,
        { operationId, details: { currentState: current.state, expectedState } }
      );
    }
    assertOperationTransition(expectedState, nextState, operationId);
    const next = {
      projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
      sourceRelativePath: patch.sourceRelativePath === undefined
        ? current.sourceRelativePath : patch.sourceRelativePath,
      targetRelativePath: patch.targetRelativePath === undefined
        ? current.targetRelativePath : patch.targetRelativePath,
      completedSteps: patch.completedSteps === undefined ? current.completedSteps : patch.completedSteps,
      payload: patch.payload === undefined ? current.payload : patch.payload,
      inversePlanVersion: patch.inversePlanVersion === undefined
        ? current.inversePlanVersion : patch.inversePlanVersion,
      updatedAt: new Date().toISOString()
    };
    const changes = this.db.run(
      `UPDATE operations SET state = ?, project_id = ?, source_relative_path = ?,
        target_relative_path = ?, completed_steps = ?, inverse_plan_version = ?, payload = ?, updated_at = ?
       WHERE operation_id = ? AND state = ?`,
      [
        nextState,
        next.projectId || null,
        next.sourceRelativePath || null,
        next.targetRelativePath || null,
        JSON.stringify(next.completedSteps),
        next.inversePlanVersion,
        JSON.stringify(next.payload || {}),
        next.updatedAt,
        operationId,
        expectedState
      ]
    ).changes;
    if (changes === 0) {
      const latest = await this.get(operationId);
      if (latest?.state === nextState) return latest;
      throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `操作状态并发变化：${operationId}`, {
        operationId,
        details: { currentState: latest?.state || null }
      });
    }
    return this.get(operationId);
  }

  /**
   * @param {string} operationId
   * @param {string} expectedState
   * @param {string} reason
   * @returns {Promise<object>}
   */
  async markNeedsRecovery(operationId, expectedState, reason) {
    const current = await this.get(operationId);
    if (!current) throw new AppError(ERROR_CODES.CONFLICT, `操作不存在：${operationId}`);
    if (current.state === 'needs_recovery') return current;
    const payload = { ...current.payload, recoveryReason: reason };
    return this.transition(operationId, expectedState, 'needs_recovery', { payload });
  }

  /**
   * @param {object} row
   * @returns {object}
   */
  mapRow(row) {
    let payload;
    let completedSteps;
    try {
      payload = JSON.parse(row.payload);
      completedSteps = JSON.parse(row.completed_steps);
    } catch {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `操作 ${row.operation_id} 的日志已损坏。`);
    }
    const record = {
      operationId: row.operation_id,
      rootId: row.root_id,
      kind: row.kind,
      state: row.state,
      completedSteps,
      inversePlanVersion: row.inverse_plan_version,
      payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    if (row.project_id) record.projectId = row.project_id;
    if (row.source_relative_path) record.sourceRelativePath = row.source_relative_path;
    if (row.target_relative_path) record.targetRelativePath = row.target_relative_path;
    return validateOperationRecord(record);
  }
}

/**
 * @param {string} rootId
 * @param {import('./database').SqliteDatabase} database
 * @returns {Promise<number>}
 */
async function countIncomplete(database, rootId) {
  const rows = database.all(
    `SELECT COUNT(*) AS count FROM operations
     WHERE root_id = ? AND state IN ('applying','awaiting_workspace','needs_recovery')`,
    [rootId]
  );
  return Number(rows[0]?.count) || 0;
}

module.exports = {
  OperationJournal,
  isIncompleteState,
  countIncomplete
};

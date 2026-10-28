'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, OPERATION_KINDS, OPERATION_STATES } = require('../shared/constants');
const { isPlainObject, assertJsonValue } = require('../shared/json');
const { normalizeRelativePath } = require('../shared/paths');

const OPERATION_KEYS = new Set([
  'operationId',
  'rootId',
  'kind',
  'state',
  'projectId',
  'sourceRelativePath',
  'targetRelativePath',
  'completedSteps',
  'inversePlanVersion',
  'payload',
  'createdAt',
  'updatedAt'
]);

const TRANSITIONS = Object.freeze({
  planned: Object.freeze(['applying', 'needs_recovery', 'undone']),
  applying: Object.freeze(['awaiting_workspace', 'completed', 'needs_recovery']),
  awaiting_workspace: Object.freeze(['completed', 'needs_recovery']),
  needs_recovery: Object.freeze(['applying', 'completed', 'undone']),
  completed: Object.freeze([]),
  undone: Object.freeze([])
});

const INCOMPLETE_STATES = Object.freeze(['applying', 'awaiting_workspace', 'needs_recovery']);

/**
 * @param {unknown} record
 * @returns {object}
 */
function validateOperationRecord(record) {
  if (!isPlainObject(record)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '操作记录必须是 JSON 对象。');
  }
  for (const key of Object.keys(record)) {
    if (!OPERATION_KEYS.has(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `操作记录包含未知字段：${key}`);
    }
  }
  if (typeof record.operationId !== 'string' || !/^op_[A-Za-z0-9-]{6,128}$/.test(record.operationId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'operationId 格式无效。');
  }
  if (typeof record.rootId !== 'string' || !/^root_[A-Za-z0-9-]{6,128}$/.test(record.rootId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '操作记录中的 rootId 格式无效。');
  }
  if (!OPERATION_KINDS.includes(record.kind)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知操作类型：${String(record.kind)}`);
  }
  if (!OPERATION_STATES.includes(record.state)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知操作状态：${String(record.state)}`);
  }
  if (record.projectId !== undefined && record.projectId !== null) {
    if (typeof record.projectId !== 'string' || !/^prj_[A-Za-z0-9-]{6,128}$/.test(record.projectId)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '操作记录中的 projectId 格式无效。');
    }
  }
  for (const key of ['sourceRelativePath', 'targetRelativePath']) {
    if (record[key] !== undefined && record[key] !== null) {
      normalizeRelativePath(record[key], { label: key });
    }
  }
  if (!Array.isArray(record.completedSteps) || record.completedSteps.some((step) => typeof step !== 'string')) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'completedSteps 必须是字符串数组。');
  }
  if (!Number.isInteger(record.inversePlanVersion) || record.inversePlanVersion < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'inversePlanVersion 必须是正整数。');
  }
  if (record.payload !== undefined) assertJsonValue(record.payload, 'payload');
  return record;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransitionOperation(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} [operationId]
 */
function assertOperationTransition(from, to, operationId) {
  if (!canTransitionOperation(from, to)) {
    throw new AppError(
      ERROR_CODES.OPERATION_INCOMPLETE,
      `操作 ${operationId || ''} 不能从 ${from} 变为 ${to}。`,
      { operationId, details: { from, to } }
    );
  }
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isIncompleteState(state) {
  return INCOMPLETE_STATES.includes(state);
}

/**
 * @param {{operationId: string, kind: string, state?: string, projectId?: string, sourceRelativePath?: string, targetRelativePath?: string, completedSteps?: string[], inversePlanVersion?: number, payload?: object, createdAt?: string, updatedAt?: string}} input
 * @returns {object}
 */
function createOperationRecord(input) {
  const now = new Date().toISOString();
  const record = {
    operationId: input.operationId,
    rootId: input.rootId,
    kind: input.kind,
    state: input.state || 'planned',
    completedSteps: input.completedSteps || [],
    inversePlanVersion: input.inversePlanVersion || 1,
    payload: input.payload || {},
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  };
  if (input.projectId !== undefined) record.projectId = input.projectId;
  if (input.sourceRelativePath !== undefined) record.sourceRelativePath = input.sourceRelativePath;
  if (input.targetRelativePath !== undefined) record.targetRelativePath = input.targetRelativePath;
  return validateOperationRecord(record);
}

module.exports = {
  TRANSITIONS,
  INCOMPLETE_STATES,
  validateOperationRecord,
  canTransitionOperation,
  assertOperationTransition,
  isIncompleteState,
  createOperationRecord
};

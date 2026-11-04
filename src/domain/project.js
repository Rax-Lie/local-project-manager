'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, PROJECT_STATUSES, MAX_DISPLAY_NAME_CHARS } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { requireRelativePath } = require('../shared/paths');
const { validateSlug } = require('../shared/slug');

const PROJECT_KEYS = new Set([
  'projectId',
  'rootId',
  'templateId',
  'templateRevision',
  'slug',
  'displayName',
  'relativePath',
  'status',
  'fieldValues',
  'createdAt',
  'updatedAt'
]);

const STATUS_TRANSITIONS = Object.freeze({
  provisioning: Object.freeze(['active', 'needs_recovery']),
  active: Object.freeze(['archiving', 'needs_recovery']),
  archiving: Object.freeze(['archived', 'needs_recovery']),
  archived: Object.freeze(['active', 'needs_recovery']),
  needs_recovery: Object.freeze(['provisioning', 'active', 'archiving', 'archived'])
});

/**
 * @param {unknown} record
 * @returns {object}
 */
function validateProjectRecord(record) {
  if (!isPlainObject(record)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目记录必须是 JSON 对象。');
  }
  for (const key of Object.keys(record)) {
    if (!PROJECT_KEYS.has(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目记录包含未知字段：${key}`);
    }
  }
  if (typeof record.projectId !== 'string' || !/^prj_[A-Za-z0-9-]{6,128}$/.test(record.projectId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'projectId 格式无效。');
  }
  if (typeof record.rootId !== 'string' || !/^root_[A-Za-z0-9-]{6,128}$/.test(record.rootId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'rootId 格式无效。');
  }
  if (typeof record.templateId !== 'string' || record.templateId.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateId 不能为空。');
  }
  if (!Number.isInteger(record.templateRevision) || record.templateRevision < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateRevision 必须是正整数。');
  }
  validateSlug(record.slug);
  if (typeof record.displayName !== 'string' || !record.displayName.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目显示名称不能为空。');
  }
  if (record.displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目显示名称过长。');
  }
  requireRelativePath(record.relativePath, '项目相对路径');
  if (!PROJECT_STATUSES.includes(record.status)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知项目状态：${String(record.status)}`);
  }
  if (!isPlainObject(record.fieldValues)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'fieldValues 必须是 JSON 对象。');
  }
  if (!isIsoDate(record.createdAt) || !isIsoDate(record.updatedAt)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目时间必须是 UTC ISO-8601 字符串。');
  }
  return record;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/**
 * @param {'provisioning'|'active'|'archiving'|'archived'|'needs_recovery'} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransitionProjectStatus(from, to) {
  return Boolean(STATUS_TRANSITIONS[from]?.includes(to));
}

/**
 * @param {string} from
 * @param {string} to
 */
function assertProjectStatusTransition(from, to) {
  if (!canTransitionProjectStatus(from, to)) {
    throw new AppError(ERROR_CODES.CONFLICT, `项目状态不能从 ${from} 变为 ${to}。`, {
      details: { from, to }
    });
  }
}

/**
 * @param {object} record
 * @returns {object}
 */
function projectSummary(record) {
  return {
    projectId: record.projectId,
    rootId: record.rootId,
    templateId: record.templateId,
    templateRevision: record.templateRevision,
    slug: record.slug,
    displayName: record.displayName,
    relativePath: record.relativePath,
    status: record.status,
    fieldValues: record.fieldValues,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * @param {object} record
 * @returns {object}
 */
function projectSnapshot(record) {
  return {
    schemaVersion: 1,
    projectId: record.projectId,
    rootId: record.rootId,
    templateId: record.templateId,
    templateRevision: record.templateRevision,
    slug: record.slug,
    displayName: record.displayName,
    relativePath: record.relativePath,
    fieldValues: record.fieldValues,
    createdAt: record.createdAt
  };
}

module.exports = {
  STATUS_TRANSITIONS,
  validateProjectRecord,
  canTransitionProjectStatus,
  assertProjectStatusTransition,
  projectSummary,
  projectSnapshot,
  isIsoDate
};

'use strict';

const { AppError } = require('../../shared/errors');
const { ERROR_CODES, PROJECT_STATUSES, LIMITS } = require('../../shared/constants');
const { hashJson } = require('../../shared/json');

const FIELD_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const CURSOR_VERSION = 1;

/**
 * @param {object} query
 * @returns {{rootId: string, text: string, status?: string, fieldFilters: object[], cursor?: string, limit: number}}
 */
function normalizeSearchQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '搜索条件必须是 JSON 对象。');
  }
  const allowed = new Set(['rootId', 'text', 'status', 'fieldFilters', 'cursor', 'limit']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `搜索条件包含未知字段：${key}`);
  }
  if (typeof query.rootId !== 'string' || !query.rootId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '搜索条件缺少 rootId。');
  }
  const text = query.text === undefined ? '' : query.text;
  if (typeof text !== 'string' || text.length > 200) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '搜索文本必须是不超过 200 字符的字符串。');
  }
  if (query.status !== undefined && !PROJECT_STATUSES.includes(query.status)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知项目状态：${String(query.status)}`);
  }
  const fieldFilters = query.fieldFilters === undefined ? [] : query.fieldFilters;
  if (!Array.isArray(fieldFilters) || fieldFilters.length > 20) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'fieldFilters 必须是不超过 20 项的数组。');
  }
  const normalizedFilters = fieldFilters.map((filter, index) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `fieldFilters[${index}] 必须是对象。`);
    }
    const operator = filter.operator === undefined ? 'eq' : filter.operator;
    if (!['eq', 'contains'].includes(operator)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `fieldFilters[${index}].operator 无效。`);
    }
    if (typeof filter.fieldId !== 'string' || !FIELD_ID_PATTERN.test(filter.fieldId)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `fieldFilters[${index}].fieldId 无效。`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof filter.value) && filter.value !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `fieldFilters[${index}].value 必须是标量。`);
    }
    return { fieldId: filter.fieldId, operator, value: filter.value };
  });
  const limit = query.limit === undefined ? LIMITS.defaultSearchLimit : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxSearchLimit) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `limit 必须是 1–${LIMITS.maxSearchLimit} 的整数。`);
  }
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 4096)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'cursor 格式无效。');
  }
  return {
    rootId: query.rootId,
    text: text.trim(),
    status: query.status,
    fieldFilters: normalizedFilters,
    cursor: query.cursor,
    limit
  };
}

/**
 * @param {{rootId: string, text?: string, status?: string, fieldFilters: object[]}} query
 * @returns {string}
 */
function searchDigest(query) {
  return hashJson({
    rootId: query.rootId,
    text: query.text || null,
    status: query.status || null,
    fieldFilters: query.fieldFilters
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * @param {{digest: string, createdAt: string, projectId: string}} payload
 * @returns {string}
 */
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    d: payload.digest,
    c: payload.createdAt,
    p: payload.projectId
  }), 'utf8').toString('base64url');
}

/**
 * @param {string} cursor
 * @param {string} digest
 * @returns {{createdAt: string, projectId: string}}
 */
function decodeCursor(cursor, digest) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'cursor 已损坏，请重新搜索。');
  }
  if (!parsed || parsed.v !== CURSOR_VERSION || parsed.d !== digest) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'cursor 与当前查询条件不匹配，请重新搜索。');
  }
  if (typeof parsed.c !== 'string' || typeof parsed.p !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'cursor 字段无效。');
  }
  return { createdAt: parsed.c, projectId: parsed.p };
}

module.exports = {
  normalizeSearchQuery,
  searchDigest,
  escapeLike,
  encodeCursor,
  decodeCursor
};

'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { ERROR_CODES } = require('./constants');

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 深度校验 JSON 值，拒绝 undefined、函数、Symbol、NaN、Infinity 和循环引用。
 * @param {unknown} value
 * @param {string} [label]
 * @param {number} [depth]
 * @returns {import('./types').JsonValue}
 */
function assertJsonValue(value, label = 'JSON 值', depth = 0) {
  if (depth > 32) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 嵌套过深。`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 不能是 NaN 或 Infinity。`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertJsonValue(value[i], `${label}[${i}]`, depth + 1);
    }
    return value;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${label}.${key}`, depth + 1);
    }
    return value;
  }
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 不是合法 JSON 值。`);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value, depth = 0) {
  if (depth > 32) throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'JSON 规范化嵌套过深。');
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '数字必须是有限值。');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, `字段 ${key} 不能是 undefined。`);
      }
      result[key] = canonicalize(child, depth + 1);
    }
    return result;
  }
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, '包含不可序列化的 JSON 值。');
}

/**
 * 稳定的 JSON 文本：对象键按字典序排列，用于计划摘要和测试断言。
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function hashJson(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(assertJsonValue(value)));
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {unknown}
 */
function parseJson(text, label = 'JSON') {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 不是合法 JSON：${error.message}`);
  }
}

module.exports = {
  isPlainObject,
  assertJsonValue,
  canonicalJson,
  sha256Hex,
  hashJson,
  cloneJson,
  parseJson
};

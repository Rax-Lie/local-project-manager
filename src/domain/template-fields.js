'use strict';

const { FIELD_TYPES, LIMITS } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { hasControlCharacters } = require('../shared/text');

const FIELD_KEYS = new Set(['id', 'label', 'type', 'required', 'choices', 'defaultValue']);
const FIELD_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * @param {unknown[]} fields
 * @param {string[]} errors
 */
function validateFields(fields, errors) {
  const ids = new Set();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const label = `fields[${index}]`;
    if (!isPlainObject(field)) {
      errors.push(`${label} 必须是 JSON 对象。`);
      continue;
    }
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS.has(key)) errors.push(`${label} 包含未知字段：${key}`);
    }
    if (typeof field.id !== 'string' || !FIELD_ID_PATTERN.test(field.id)) {
      errors.push(`${label}.id 格式无效。`);
    } else if (ids.has(field.id)) {
      errors.push(`字段 id 重复：${field.id}`);
    } else {
      ids.add(field.id);
    }
    if (typeof field.label !== 'string' || !field.label.trim()) {
      errors.push(`${label}.label 必须是非空字符串。`);
    } else if (field.label.length > 80) {
      errors.push(`${label}.label 不能超过 80 字符。`);
    }
    if (hasControlCharacters(field.label)) {
      errors.push(`${label}.label 不能包含控制字符。`);
    }
    if (!FIELD_TYPES.includes(field.type)) {
      errors.push(`${label}.type 必须是 ${FIELD_TYPES.join('/')} 之一。`);
    }
    if (typeof field.required !== 'boolean') errors.push(`${label}.required 必须是布尔值。`);
    validateChoices(field, label, errors);
    if (field.defaultValue !== undefined) {
      const result = checkFieldValue(field, field.defaultValue, { allowNull: true });
      if (result.error) errors.push(`${label}.defaultValue：${result.error}`);
    }
  }
}

/**
 * @param {object} field
 * @param {string} label
 * @param {string[]} errors
 */
function validateChoices(field, label, errors) {
  if (field.type !== 'choice') {
    if (field.choices !== undefined) errors.push(`${label}.choices 只允许用于 choice 字段。`);
    return;
  }
  if (!Array.isArray(field.choices) || field.choices.length === 0) {
    errors.push(`${label}.choices 必须是非空数组。`);
    return;
  }
  if (field.choices.length > LIMITS.maxChoices) {
    errors.push(`${label}.choices 不能超过 ${LIMITS.maxChoices} 项。`);
    return;
  }
  const seen = new Set();
  for (const choice of field.choices) {
    if (typeof choice !== 'string' || choice.trim() === '' || choice.length > 200) {
      errors.push(`${label}.choices 包含非法选项。`);
    } else if (seen.has(choice)) {
      errors.push(`${label}.choices 包含重复选项：${choice}`);
    } else {
      seen.add(choice);
    }
  }
}

/**
 * @param {object} field
 * @param {unknown} value
 * @param {{allowNull?: boolean}} [options]
 * @returns {{value?: unknown, error?: string}}
 */
function checkFieldValue(field, value, options = {}) {
  if (value === null) {
    if (options.allowNull) return { value: null };
    return { error: '值不能为 null。' };
  }
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return { error: '必须是字符串。' };
      if (value.length > LIMITS.maxTextFieldChars) {
        return { error: `不能超过 ${LIMITS.maxTextFieldChars} 字符。` };
      }
      if (value.includes('\u0000')) return { error: '不能包含 NUL 字符。' };
      if (field.required && value.trim() === '') return { error: '必填文本不能为空。' };
      return { value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: '必须是有限数字。' };
      return { value };
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { error: '日期必须是 YYYY-MM-DD。' };
      }
      if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return { error: '日期无效。' };
      if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        return { error: '日期无效。' };
      }
      return { value };
    case 'boolean':
      if (typeof value !== 'boolean') return { error: '必须是布尔值。' };
      return { value };
    case 'choice':
      if (typeof value !== 'string' || !field.choices.includes(value)) {
        return { error: '必须是 choices 中的选项。' };
      }
      return { value };
    default:
      return { error: `未知字段类型：${String(field.type)}` };
  }
}

module.exports = {
  FIELD_KEYS,
  validateFields,
  checkFieldValue
};

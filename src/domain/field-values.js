'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { validateTemplate } = require('./template');
const { checkFieldValue } = require('./template-fields');

/**
 * 校验并补全字段值：未知字段拒绝，缺失可选字段使用默认值或 null。
 * @param {object} template
 * @param {unknown} fieldValues
 * @returns {Record<string, unknown>}
 */
function normalizeFieldValues(template, fieldValues) {
  validateTemplate(template);
  if (!isPlainObject(fieldValues)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'fieldValues 必须是 JSON 对象。');
  }
  const fieldsById = new Map(template.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(fieldValues)) {
    if (!fieldsById.has(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知模板字段：${key}`);
    }
  }
  const result = {};
  for (const field of template.fields) {
    const hasValue = Object.prototype.hasOwnProperty.call(fieldValues, field.id);
    let value = hasValue ? fieldValues[field.id] : undefined;
    if (value === undefined) {
      value = field.defaultValue === undefined ? null : field.defaultValue;
    }
    if (value === null) {
      if (field.required) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, `字段「${field.label}」为必填项。`);
      }
      result[field.id] = null;
      continue;
    }
    if (field.type === 'text' && typeof value === 'string' && value === '') {
      if (field.required) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, `字段「${field.label}」为必填项。`);
      }
      result[field.id] = '';
      continue;
    }
    const checked = checkFieldValue(field, value);
    if (checked.error) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `字段「${field.label}」：${checked.error}`);
    }
    result[field.id] = checked.value;
  }
  return result;
}

module.exports = {
  normalizeFieldValues
};

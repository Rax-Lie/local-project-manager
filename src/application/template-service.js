'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { collectTemplateErrors, validateTemplate } = require('../domain/template');
const { withRootContext, discoverTemplates } = require('./context');

/**
 * @param {{rootUri: string, rootId?: string}} payload
 * @returns {Promise<object>}
 */
async function listTemplates(payload) {
  assertPayload(payload, ['rootUri', 'rootId'], 'template.list');
  return withRootContext(payload.rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    return {
      rootId: context.config.rootId,
      templates: discovered.entries.map((entry) => ({
        ...entry.template,
        relativePath: entry.relativePath
      })),
      diagnostics: discovered.diagnostics
    };
  });
}

/**
 * 支持直接校验模板 DTO，或按 rootUri + templateId 读取文件后校验。
 * @param {{rootUri?: string, rootId?: string, template?: object, templateId?: string}} payload
 * @returns {Promise<object>}
 */
async function validateTemplateOperation(payload) {
  assertPayload(payload, ['rootUri', 'rootId', 'template', 'templateId'], 'template.validate');
  if (payload.template !== undefined) {
    const errors = collectTemplateErrors(payload.template);
    return { valid: errors.length === 0, errors };
  }
  if (!payload.rootUri || !payload.templateId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'template.validate 需要 template 或 rootUri + templateId。');
  }
  return withRootContext(payload.rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    const discovered = await discoverTemplates(context.fs);
    const entry = discovered.entries.find((item) => item.template.id === payload.templateId);
    if (!entry) {
      const diagnostic = discovered.diagnostics.find((item) => item.file?.includes(payload.templateId));
      return {
        valid: false,
        errors: [diagnostic?.message || `找不到模板：${payload.templateId}`],
        diagnostics: discovered.diagnostics
      };
    }
    validateTemplate(entry.template);
    return { valid: true, errors: [], template: entry.template, relativePath: entry.relativePath };
  });
}

/**
 * @param {string} actual
 * @param {unknown} expected
 */
function assertRootId(actual, expected) {
  if (expected !== undefined && expected !== null && expected !== actual) {
    throw new AppError(ERROR_CODES.CONFLICT, 'rootId 与目标管理根不匹配。', {
      details: { expected, actual }
    });
  }
}

/**
 * @param {unknown} payload
 * @param {string[]} allowed
 * @param {string} label
 */
function assertPayload(payload, allowed, label) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 的 payload 必须是对象。`);
  }
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含未知字段：${key}`);
    }
  }
}

module.exports = {
  listTemplates,
  validateTemplateOperation,
  assertRootId
};

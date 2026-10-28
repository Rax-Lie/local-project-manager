'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, LIMITS, SNAPSHOT_FILE } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { hasControlCharacters } = require('../shared/text');
const { normalizeRelativePath } = require('../shared/paths');
const { validateFields } = require('./template-fields');

const TEMPLATE_KEYS = new Set(['id', 'revision', 'displayName', 'fields', 'directoryBlueprint', 'markdownTemplates']);
const MARKDOWN_KEYS = new Set(['id', 'displayName', 'targetPath', 'content']);
const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const MARKDOWN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} errors
 */
function requireString(value, label, errors, maxLength = 500) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} 必须是非空字符串。`);
    return '';
  }
  if (value.length > maxLength) {
    errors.push(`${label} 不能超过 ${maxLength} 字符。`);
  }
  if (hasControlCharacters(value)) {
    errors.push(`${label} 不能包含控制字符。`);
  }
  return value;
}

/**
 * 收集模板的全部结构错误，便于 UI 一次展示。
 * @param {unknown} template
 * @returns {string[]}
 */
function collectTemplateErrors(template) {
  const errors = [];
  if (!isPlainObject(template)) return ['模板必须是 JSON 对象。'];
  for (const key of Object.keys(template)) {
    if (!TEMPLATE_KEYS.has(key)) errors.push(`模板包含未知字段：${key}`);
  }
  if (typeof template.id !== 'string' || !TEMPLATE_ID_PATTERN.test(template.id)) {
    errors.push('模板 id 必须匹配 ^[a-z][a-z0-9-]{1,63}$。');
  }
  if (!Number.isInteger(template.revision) || template.revision < 1) {
    errors.push('模板 revision 必须是正整数。');
  }
  requireString(template.displayName, '模板 displayName', errors, 80);

  if (!Array.isArray(template.fields)) {
    errors.push('模板 fields 必须是数组。');
  } else if (template.fields.length > LIMITS.maxFields) {
    errors.push(`模板字段不能超过 ${LIMITS.maxFields} 个。`);
  } else {
    validateFields(template.fields, errors);
  }

  if (!Array.isArray(template.directoryBlueprint)) {
    errors.push('模板 directoryBlueprint 必须是数组。');
  } else {
    validateBlueprint(template.directoryBlueprint, errors);
  }

  if (!Array.isArray(template.markdownTemplates)) {
    errors.push('模板 markdownTemplates 必须是数组。');
  } else {
    validateMarkdownTemplates(template.markdownTemplates, errors);
  }
  return errors;
}

/**
 * @param {unknown[]} blueprint
 * @param {string[]} errors
 */
function validateBlueprint(blueprint, errors) {
  if (blueprint.length > LIMITS.maxDirectoryEntries) {
    errors.push(`directoryBlueprint 不能超过 ${LIMITS.maxDirectoryEntries} 项。`);
  }
  const seen = new Set();
  for (let index = 0; index < blueprint.length; index += 1) {
    if (typeof blueprint[index] !== 'string' || blueprint[index].trim() === '') {
      errors.push(`directoryBlueprint[${index}] 必须是非空字符串。`);
      continue;
    }
    try {
      const normalized = normalizeRelativePath(blueprint[index], { label: '目录骨架' });
      const key = normalized.toLowerCase();
      if (seen.has(key)) errors.push(`目录骨架重复：${normalized}`);
      if (key === '.pm' || key.startsWith('.pm/')) errors.push(`目录骨架不能位于 .pm 中：${normalized}`);
      if (key === SNAPSHOT_FILE) errors.push(`目录骨架不能占用元数据快照文件：${normalized}`);
      seen.add(key);
    } catch (error) {
      errors.push(error.message);
    }
  }
}

/**
 * @param {unknown[]} templates
 * @param {string[]} errors
 */
function validateMarkdownTemplates(templates, errors) {
  if (templates.length > LIMITS.maxMarkdownTemplates) {
    errors.push(`markdownTemplates 不能超过 ${LIMITS.maxMarkdownTemplates} 项。`);
  }
  const ids = new Set();
  const targets = new Set();
  for (let index = 0; index < templates.length; index += 1) {
    const item = templates[index];
    const label = `markdownTemplates[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${label} 必须是 JSON 对象。`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!MARKDOWN_KEYS.has(key)) errors.push(`${label} 包含未知字段：${key}`);
    }
    if (typeof item.id !== 'string' || !MARKDOWN_ID_PATTERN.test(item.id)) {
      errors.push(`${label}.id 格式无效。`);
    } else if (ids.has(item.id)) {
      errors.push(`Markdown 模板 id 重复：${item.id}`);
    } else {
      ids.add(item.id);
    }
    if (item.displayName !== undefined) requireString(item.displayName, `${label}.displayName`, errors, 80);
    try {
      const targetPath = normalizeRelativePath(item.targetPath, { label: 'Markdown 目标路径' });
      const key = targetPath.toLowerCase();
      if (targets.has(key)) errors.push(`Markdown 目标路径重复：${targetPath}`);
      if (key === '.pm' || key.startsWith('.pm/')) errors.push(`Markdown 目标路径不能位于 .pm 中。`);
      if (key === SNAPSHOT_FILE) errors.push(`Markdown 目标路径不能占用元数据快照文件。`);
      targets.add(key);
    } catch (error) {
      errors.push(error.message);
    }
    if (typeof item.content !== 'string') {
      errors.push(`${label}.content 必须是字符串。`);
    } else if (Buffer.byteLength(item.content, 'utf8') > LIMITS.maxMarkdownBytes) {
      errors.push(`${label}.content 超过 1 MiB 上限。`);
    }
  }
}

/**
 * @param {unknown} template
 * @returns {object}
 */
function validateTemplate(template) {
  const errors = collectTemplateErrors(template);
  if (errors.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `模板校验失败：${errors[0]}`, {
      details: { errors }
    });
  }
  return template;
}

/**
 * @param {object} template
 * @returns {Array<{id: string, displayName: string, targetPath: string, content: string}>}
 */
function markdownTemplatesOf(template) {
  return template.markdownTemplates.map((item) => ({
    id: item.id,
    displayName: item.displayName || item.targetPath,
    targetPath: item.targetPath,
    content: item.content
  }));
}

/**
 * @param {string} text
 * @param {object} context
 * @returns {string}
 */
function renderMarkdown(text, context) {
  const values = buildRenderValues(context);
  const unresolved = new Set();
  const rendered = text.replace(/\$\{([^{}]+)\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      unresolved.add(key);
      return match;
    }
    return stringifyValue(values[key]);
  });
  if (unresolved.size > 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Markdown 模板包含未知变量：${[...unresolved].join(', ')}`,
      { details: { unknownVariables: [...unresolved] } }
    );
  }
  if (Buffer.byteLength(rendered, 'utf8') > LIMITS.maxMarkdownBytes * 2) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '渲染后的 Markdown 超过大小上限。');
  }
  return rendered;
}

/**
 * @param {object} context
 * @returns {Record<string, unknown>}
 */
function buildRenderValues(context) {
  const project = context.project || {};
  const root = context.root || {};
  const values = {
    'project.displayName': project.displayName,
    'project.slug': project.slug,
    'project.relativePath': project.relativePath,
    'project.createdAt': project.createdAt,
    'root.displayName': root.displayName,
    'root.rootId': root.rootId,
    'date.today': new Date().toISOString().slice(0, 10),
    'date.now': new Date().toISOString()
  };
  for (const [fieldId, value] of Object.entries(context.fieldValues || {})) {
    values[`field.${fieldId}`] = value;
  }
  return values;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

module.exports = {
  collectTemplateErrors,
  validateTemplate,
  markdownTemplatesOf,
  renderMarkdown
};

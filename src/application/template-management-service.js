'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject, hashJson } = require('../shared/json');
const { normalizeFileUri } = require('../shared/paths');
const { validateTemplate } = require('../domain/template');
const { withRootContext, discoverTemplates, findTemplate, serializeTemplate } = require('./context');
const { assertRootId, assertPayload } = require('./template-service');
const { replaceFileAtomically } = require('../adapters/filesystem/atomic-file');

/** @param {unknown} payload */
async function createTemplate(payload) {
  assertPayload(payload, ['rootUri', 'rootId', 'template'], 'template.create');
  const input = templateInput(payload);
  validateTemplate(input.template);
  if (input.template.revision !== 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '新模板的 revision 必须从 1 开始。');
  }
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const file = serializeTemplate(input.template);
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    const existing = await context.fs.inspect(file.relativePath);
    const indexed = await context.templateIndex.get(context.config.rootId, input.template.id);
    if (existing.exists) {
      const current = await context.fs.readJson(file.relativePath);
      if (hashJson(current) === hashJson(input.template)) {
        return templateResult(input.template, indexed?.enabled ?? true, false);
      }
      throw new AppError(ERROR_CODES.CONFLICT, `模板已存在：${input.template.id}`);
    }
    if (indexed) throw new AppError(ERROR_CODES.CONFLICT, `模板 ID 已登记：${input.template.id}`);
    await context.fs.writeFileExclusive(file.relativePath, file.content);
    const latest = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, latest.entries);
    return templateResult(input.template, true, true);
  });
}

/** @param {unknown} payload */
async function updateTemplate(payload) {
  assertPayload(payload, ['rootUri', 'rootId', 'templateId', 'expectedRevision', 'template'], 'template.update');
  const input = templateInput(payload);
  assertRevision(payload.expectedRevision);
  if (typeof payload.templateId !== 'string' || payload.templateId !== input.template.id) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateId 必须与模板 DTO 的 id 一致。');
  }
  if (input.template.revision !== payload.expectedRevision + 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '更新模板的 revision 必须等于 expectedRevision + 1。');
  }
  validateTemplate(input.template);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    const entry = findTemplate(discovered.entries, input.template.id);
    if (entry.template.revision === input.template.revision
      && hashJson(entry.template) === hashJson(input.template)) {
      const indexed = await context.templateIndex.get(context.config.rootId, input.template.id);
      return templateResult(input.template, indexed?.enabled ?? true, false);
    }
    assertCurrentRevision(entry.template.revision, payload.expectedRevision);
    const previous = await context.fs.readText(entry.relativePath);
    const next = serializeTemplate(input.template);
    await replaceFileAtomically(context.fs, entry.relativePath, previous, next.content);
    const updated = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, updated.entries);
    const indexed = await context.templateIndex.get(context.config.rootId, input.template.id);
    return templateResult(input.template, indexed?.enabled ?? true, true);
  });
}

/** @param {unknown} payload */
async function deleteTemplate(payload) {
  assertPayload(payload, ['rootUri', 'rootId', 'templateId', 'expectedRevision'], 'template.delete');
  const rootUri = normalizeFileUri(payload.rootUri);
  const rootId = requireRootId(payload.rootId);
  validateTemplateIdentity(payload.templateId);
  assertRevision(payload.expectedRevision);
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, rootId);
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    const index = await context.templateIndex.get(context.config.rootId, payload.templateId);
    const entry = discovered.entries.find((item) => item.template.id === payload.templateId);
    if (!entry || !index) {
      if (index && !index.enabled && index.revision === payload.expectedRevision) {
        return { templateId: payload.templateId, deleted: true, retained: true, enabled: false };
      }
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `找不到模板：${payload.templateId}`);
    }
    assertCurrentRevision(entry.template.revision, payload.expectedRevision);
    await context.templateIndex.setEnabled(context.config.rootId, payload.templateId, payload.expectedRevision, false);
    return { templateId: payload.templateId, deleted: true, retained: true, enabled: false };
  });
}

/** @param {unknown} payload */
async function setTemplateEnabled(payload) {
  assertPayload(payload, ['rootUri', 'rootId', 'templateId', 'expectedRevision', 'enabled'], 'template.setEnabled');
  const rootUri = normalizeFileUri(payload.rootUri);
  const rootId = requireRootId(payload.rootId);
  validateTemplateIdentity(payload.templateId);
  assertRevision(payload.expectedRevision);
  if (typeof payload.enabled !== 'boolean') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'enabled 必须是布尔值。');
  }
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, rootId);
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    const entry = findTemplate(discovered.entries, payload.templateId);
    assertCurrentRevision(entry.template.revision, payload.expectedRevision);
    const previous = await context.templateIndex.get(context.config.rootId, payload.templateId);
    const index = await context.templateIndex.setEnabled(
      context.config.rootId, payload.templateId, payload.expectedRevision, payload.enabled
    );
    if (!index) throw new AppError(ERROR_CODES.CONFLICT, '模板版本已经变化，请刷新后重试。');
    return templateResult(entry.template, index.enabled, previous?.enabled !== index.enabled);
  });
}

function templateInput(payload) {
  if (!isPlainObject(payload.template)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'template 必须是模板 JSON 对象。');
  }
  return {
    rootUri: normalizeFileUri(payload.rootUri),
    rootId: requireRootId(payload.rootId),
    template: payload.template
  };
}

function requireRootId(rootId) {
  if (typeof rootId !== 'string' || !rootId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'rootId 必须是非空字符串。');
  }
  return rootId;
}

function validateTemplateIdentity(templateId) {
  if (typeof templateId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(templateId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateId 格式无效。');
  }
}

function assertRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'expectedRevision 必须是正整数。');
  }
}

function assertCurrentRevision(actual, expected) {
  if (actual !== expected) {
    throw new AppError(ERROR_CODES.CONFLICT, `模板版本已变化：当前为 ${actual}，输入期望 ${expected}。`);
  }
}

function templateResult(template, enabled, changed) {
  return {
    template: { ...template, enabled },
    enabled,
    changed
  };
}

module.exports = {
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setTemplateEnabled
};

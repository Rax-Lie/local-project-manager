'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, MAX_DISPLAY_NAME_CHARS } = require('../shared/constants');
const { isPlainObject, hashJson } = require('../shared/json');
const { hasControlCharacters } = require('../shared/text');
const { normalizeFileUri } = require('../shared/paths');
const { newProjectId, newOperationId, newPlanId } = require('../shared/ids');
const { slugify, slugCandidates } = require('../shared/slug');
const { markdownTemplatesOf } = require('../domain/template');
const { normalizeFieldValues } = require('../domain/field-values');
const { partitionById } = require('../domain/root-config');
const { createPlan } = require('../domain/plan');
const { withRootContext, discoverTemplates, findTemplate } = require('./context');
const { assertRootId } = require('./template-service');

const CREATE_INPUT_KEYS = ['rootUri', 'rootId', 'templateId', 'expectedTemplateRevision', 'displayName', 'fieldValues'];
const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * @param {unknown} payload
 * @returns {{rootUri: string, rootId?: string, templateId: string, expectedTemplateRevision: number, displayName: string, fieldValues: object}}
 */
function normalizeCreateInput(payload) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '新建项目输入必须是 JSON 对象。');
  }
  for (const key of Object.keys(payload)) {
    if (!CREATE_INPUT_KEYS.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `新建项目输入包含未知字段：${key}`);
    }
  }
  const rootUri = normalizeFileUri(payload.rootUri);
  if (payload.rootId !== undefined && (typeof payload.rootId !== 'string' || !payload.rootId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'rootId 必须是字符串。');
  }
  if (typeof payload.templateId !== 'string' || !TEMPLATE_ID_PATTERN.test(payload.templateId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateId 格式无效。');
  }
  if (!Number.isInteger(payload.expectedTemplateRevision) || payload.expectedTemplateRevision < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'expectedTemplateRevision 必须是正整数。');
  }
  const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目显示名称必须是 1–120 字符。');
  }
  if (hasControlCharacters(displayName)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目显示名称不能包含控制字符。');
  }
  if (!isPlainObject(payload.fieldValues)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'fieldValues 必须是 JSON 对象。');
  }
  return {
    rootUri,
    rootId: payload.rootId,
    templateId: payload.templateId,
    expectedTemplateRevision: payload.expectedTemplateRevision,
    displayName,
    fieldValues: payload.fieldValues
  };
}

/**
 * 在 projects 分区中选择未占用的 slug 和相对路径。
 * @param {object} context
 * @param {string} displayName
 * @returns {Promise<{slug: string, relativePath: string, conflicts: object[]}>}
 */
async function resolveProjectLocation(context, displayName) {
  const projectsPartition = partitionById(context.config, 'projects');
  const partitionInfo = await context.fs.inspect(projectsPartition.relativePath);
  if (!partitionInfo.exists || partitionInfo.type !== 'directory') {
    throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, 'projects 分区目录缺失，请先恢复管理根。');
  }
  const base = slugify(displayName, context.config.slugRules);
  const candidates = slugCandidates(base, context.config.slugRules);
  for (const slug of candidates) {
    const relativePath = `${projectsPartition.relativePath}/${slug}`;
    const bySlug = await context.repo.getBySlug(context.config.rootId, slug);
    const byPath = await context.repo.getByRelativePath(context.config.rootId, relativePath);
    const info = await context.fs.inspect(relativePath);
    if (!bySlug && !byPath && !info.exists) {
      return { slug, relativePath, conflicts: [] };
    }
  }
  const relativePath = `${projectsPartition.relativePath}/${base}`;
  return {
    slug: base,
    relativePath,
    conflicts: [{
      code: 'SLUG_CONFLICT',
      severity: 'error',
      message: `slug 候选 ${base} 及 -2 到 -50 均已被占用，请修改项目显示名称。`
    }]
  };
}

/**
 * @param {unknown} payload
 * @returns {Promise<object>}
 */
async function planProjectCreation(payload) {
  const input = normalizeCreateInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const discovered = await discoverTemplates(context.fs);
    const entry = findTemplate(discovered.entries, input.templateId);
    const template = entry.template;
    if (template.revision !== input.expectedTemplateRevision) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `模板版本已变化：当前为 ${template.revision}，输入期望 ${input.expectedTemplateRevision}。请刷新后重试。`
      );
    }
    const fieldValues = normalizeFieldValues(template, input.fieldValues);
    const location = await resolveProjectLocation(context, input.displayName);
    const projectId = newProjectId();
    const markdownTemplates = markdownTemplatesOf(template);
    const templateHash = hashJson(template);
    const warnings = [...location.conflicts];
    if (discovered.diagnostics.length > 0) {
      warnings.push(...discovered.diagnostics.map((item) => ({
        code: item.code,
        severity: item.severity,
        message: item.message
      })));
    }
    const plan = createPlan({
      kind: 'project.create',
      planId: newPlanId(),
      operationId: newOperationId(),
      input,
      expectedConfigRevision: context.config.configRevision,
      expectedTemplateRevision: template.revision,
      target: {
        projectId,
        slug: location.slug,
        relativePath: location.relativePath,
        templateId: template.id,
        templateHash
      },
      summary: {
        title: '新建项目',
        lines: [
          `显示名称：${input.displayName}`,
          `目录 slug：${location.slug}`,
          `相对路径：${location.relativePath}`,
          `模板：${template.displayName} (revision ${template.revision})`,
          `字段：${formatFields(template, fieldValues)}`,
          `目录骨架：${template.directoryBlueprint.join('、') || '（无）'}`,
          `Markdown 文件：${markdownTemplates.map((item) => item.targetPath).join('、') || '（无）'}`
        ],
        warnings
      },
      details: {
        projectId,
        slug: location.slug,
        relativePath: location.relativePath,
        templateId: template.id,
        templateRevision: template.revision,
        templateHash,
        displayName: input.displayName,
        fieldValues,
        directories: template.directoryBlueprint,
        markdownTemplates: markdownTemplates.map((item) => ({ id: item.id, targetPath: item.targetPath })),
        conflicts: location.conflicts,
        templateRelativePath: entry.relativePath
      }
    });
    return plan;
  });
}

/**
 * @param {object} template
 * @param {object} fieldValues
 * @returns {string}
 */
function formatFields(template, fieldValues) {
  if (template.fields.length === 0) return '（无）';
  return template.fields.map((field) => {
    let value = fieldValues[field.id];
    if (value === null || value === undefined || value === '') value = '（空）';
    if (typeof value === 'boolean') value = value ? '是' : '否';
    return `${field.label}=${String(value)}`;
  }).join('；');
}

module.exports = {
  normalizeCreateInput,
  resolveProjectLocation,
  planProjectCreation,
  formatFields
};

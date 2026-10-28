'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const { ERROR_CODES, SNAPSHOT_FILE } = require('../shared/constants');
const { isPlainObject, hashJson, sha256Hex } = require('../shared/json');
const { normalizeFileUri, normalizeRelativePath, isPathInsideOrEqual } = require('../shared/paths');
const { newOperationId, newPlanId } = require('../shared/ids');
const { renderMarkdown, markdownTemplatesOf } = require('../domain/template');
const { createPlan, verifyPlan } = require('../domain/plan');
const { createOperationRecord } = require('../domain/operation');
const { withRootContext, discoverTemplates, findTemplate } = require('./context');
const { assertRootId, assertTemplateEnabled } = require('./template-service');

const INPUT_KEYS = ['rootUri', 'rootId', 'projectId', 'templateId', 'expectedTemplateRevision', 'markdownId'];
const OPERATION_ID_PATTERN = /^op_[A-Za-z0-9-]{6,128}$/;

/**
 * @param {unknown} payload
 * @returns {{rootUri: string, rootId?: string, projectId: string, templateId: string, expectedTemplateRevision: number, markdownId: string}}
 */
function normalizeFileInput(payload) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '文件模板输入必须是 JSON 对象。');
  }
  for (const key of Object.keys(payload)) {
    if (!INPUT_KEYS.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `文件模板输入包含未知字段：${key}`);
    }
  }
  const rootUri = normalizeFileUri(payload.rootUri);
  if (typeof payload.projectId !== 'string' || !payload.projectId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'projectId 不能为空。');
  }
  if (typeof payload.templateId !== 'string' || !payload.templateId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'templateId 不能为空。');
  }
  if (!Number.isInteger(payload.expectedTemplateRevision) || payload.expectedTemplateRevision < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'expectedTemplateRevision 必须是正整数。');
  }
  if (typeof payload.markdownId !== 'string' || !payload.markdownId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'markdownId 不能为空。');
  }
  return {
    rootUri,
    rootId: payload.rootId,
    projectId: payload.projectId,
    templateId: payload.templateId,
    expectedTemplateRevision: payload.expectedTemplateRevision,
    markdownId: payload.markdownId
  };
}

/**
 * @param {unknown} payload
 * @returns {Promise<object>}
 */
async function planFileTemplate(payload) {
  const input = normalizeFileInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    if (!project) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目不存在：${input.projectId}`);
    if (project.status === 'archived' || project.status === 'archiving') {
      throw new AppError(ERROR_CODES.CONFLICT, '归档项目不能写入新文件。');
    }
    const discovered = await discoverTemplates(context.fs);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    const entry = findTemplate(discovered.entries, input.templateId);
    await assertTemplateEnabled(context, input.templateId);
    const template = entry.template;
    if (template.revision !== input.expectedTemplateRevision) {
      throw new AppError(ERROR_CODES.CONFLICT, `模板版本已变化，当前为 ${template.revision}。`);
    }
    const markdown = markdownTemplatesOf(template).find((item) => item.id === input.markdownId);
    if (!markdown) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `模板中没有 Markdown 文件：${input.markdownId}`);
    }
    const targetPath = normalizeRelativePath(`${project.relativePath}/${markdown.targetPath}`, {
      label: 'Markdown 目标路径'
    });
    if (!isPathInsideOrEqual(`${context.rootPath}${path.sep}${project.relativePath}`,
      path.join(context.rootPath, ...targetPath.split('/')))) {
      throw new AppError(ERROR_CODES.PATH_ESCAPE, 'Markdown 目标路径逃逸出项目目录。');
    }
    const info = await context.fs.inspect(targetPath);
    const content = renderMarkdown(markdown.content, {
      project,
      root: context.config,
      fieldValues: project.fieldValues
    });
    const contentHash = sha256Hex(content);
    const blocking = info.exists;
    const warnings = blocking ? [{
      code: 'TARGET_EXISTS',
      severity: 'error',
      message: `目标文件已存在，写入已阻止：${targetPath}`
    }] : [];
    const plan = createPlan({
      kind: 'project.file',
      planId: newPlanId(),
      operationId: newOperationId(),
      input,
      expectedConfigRevision: context.config.configRevision,
      expectedTemplateRevision: template.revision,
      target: {
        projectId: project.projectId,
        templateId: template.id,
        templateRevision: template.revision,
        markdownId: markdown.id,
        targetPath,
        contentHash
      },
      summary: {
        title: '写入 Markdown 文件',
        lines: [
          `项目：${project.displayName}`,
          `模板：${template.displayName} / ${markdown.displayName}`,
          `目标：${targetPath}`,
          `字节数：${Buffer.byteLength(content, 'utf8')}`
        ],
        warnings
      },
      details: {
        projectId: project.projectId,
        targetPath,
        content,
        contentHash,
        blocking,
        templateId: template.id,
        markdownId: markdown.id
      }
    });
    return plan;
  });
}

/**
 * @param {{plan: object, input: object}} payload
 * @returns {Promise<object>}
 */
async function executeFileTemplate(payload) {
  if (!isPlainObject(payload) || !payload.plan || !payload.input) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '执行文件模板需要 plan 和 input。');
  }
  for (const key of Object.keys(payload)) {
    if (!['plan', 'input'].includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `执行文件模板包含未知字段：${key}`);
    }
  }
  const input = normalizeFileInput(payload.input);
  const plan = payload.plan;
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    if (!project) throw new AppError(ERROR_CODES.CONFLICT, `项目不存在：${input.projectId}`);
    const discovered = await discoverTemplates(context.fs);
    const entry = findTemplate(discovered.entries, input.templateId);
    const template = entry.template;
    if (template.revision !== input.expectedTemplateRevision) {
      throw new AppError(ERROR_CODES.CONFLICT, '模板版本已变化，请重新预览。');
    }
    const markdown = markdownTemplatesOf(template).find((item) => item.id === input.markdownId);
    if (!markdown) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '找不到 Markdown 模板。');
    const targetPath = normalizeRelativePath(`${project.relativePath}/${markdown.targetPath}`, {
      label: 'Markdown 目标路径'
    });
    const content = renderMarkdown(markdown.content, {
      project,
      root: context.config,
      fieldValues: project.fieldValues
    });
    const contentHash = sha256Hex(content);
    verifyPlan(plan, {
      kind: 'project.file',
      input,
      expectedConfigRevision: context.config.configRevision,
      expectedTemplateRevision: template.revision,
      target: {
        projectId: project.projectId,
        templateId: template.id,
        templateRevision: template.revision,
        markdownId: markdown.id,
        targetPath,
        contentHash
      }
    });

    const existing = await context.journal.get(plan.operationId);
    if (existing) return handleExistingFileOperation(context, plan, existing, targetPath);
    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    await assertTemplateEnabled(context, input.templateId);
    if (plan.details?.blocking) {
      throw new AppError(ERROR_CODES.CONFLICT, '目标文件已存在，写入已阻止。');
    }
    const info = await context.fs.inspect(targetPath);
    if (info.exists) throw new AppError(ERROR_CODES.CONFLICT, `目标文件已存在：${targetPath}`);

    let started = false;
    try {
      const { content: _content, ...planDetails } = plan.details || {};
      await context.journal.begin(createOperationRecord({
        operationId: plan.operationId,
        rootId: context.config.rootId,
        kind: 'project.file.write',
        state: 'applying',
        projectId: project.projectId,
        targetRelativePath: targetPath,
        payload: { input, plan: { ...plan, details: planDetails } },
        completedSteps: []
      }));
      started = true;
      const parent = path.posix.dirname(targetPath);
      if (parent && parent !== '.' && parent !== project.relativePath) {
        await context.fs.createDirectoryTree(parent);
      }
      await context.fs.writeFileExclusive(targetPath, content);
      await context.journal.transition(plan.operationId, 'applying', 'completed', {
        completedSteps: ['file_written']
      });
      return {
        operationId: plan.operationId,
        state: 'completed',
        changedPaths: [targetPath],
        requiresWorkspaceSync: false,
        warnings: [],
        project: project
      };
    } catch (error) {
      if (started) {
        try {
          await context.journal.markNeedsRecovery(plan.operationId, 'applying', error.message);
        } catch { /* 保留原始错误 */ }
      }
      const appError = normalizeError(error);
      appError.operationId = plan.operationId;
      throw appError;
    }
  });
}

/**
 * @param {object} context
 * @param {object} plan
 * @param {object} operation
 * @param {string} targetPath
 */
async function handleExistingFileOperation(context, plan, operation, targetPath) {
  if (operation.kind !== 'project.file.write') {
    throw new AppError(ERROR_CODES.CONFLICT, 'operationId 已被其他操作占用。');
  }
  if (operation.state === 'completed') {
    return {
      operationId: operation.operationId,
      state: 'completed',
      changedPaths: [targetPath],
      requiresWorkspaceSync: false,
      warnings: [{ code: 'ALREADY_WRITTEN', severity: 'info', message: '文件已写入，未重复操作。' }]
    };
  }
  if (operation.state === 'needs_recovery') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '文件写入操作需要人工恢复。');
  }
  throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `文件写入操作状态为 ${operation.state}。`);
}

module.exports = {
  normalizeFileInput,
  planFileTemplate,
  executeFileTemplate,
  OPERATION_ID_PATTERN
};

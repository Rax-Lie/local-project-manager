'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const { ERROR_CODES, SNAPSHOT_FILE } = require('../shared/constants');
const { isPlainObject, hashJson } = require('../shared/json');
const { pathToFileUri } = require('../shared/paths');
const { nowIso } = require('../shared/ids');
const { validateSlug } = require('../shared/slug');
const { normalizeFieldValues } = require('../domain/field-values');
const { projectSummary, projectSnapshot } = require('../domain/project');
const { verifyPlan } = require('../domain/plan');
const { createOperationRecord } = require('../domain/operation');
const { withRootContext, discoverTemplates, findTemplate } = require('./context');
const { normalizeCreateInput } = require('./project-plan');
const { assertRootId } = require('./template-service');

const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9-]{6,128}$/;

/**
 * @param {{plan: object, input: object}} payload
 * @returns {Promise<object>}
 */
async function executeProjectCreation(payload) {
  assertExecutePayload(payload);
  const input = normalizeCreateInput(payload.input);
  if (!isPlainObject(payload.plan)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 ConfirmedPlan。');
  }
  const plan = payload.plan;
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const details = plan.details || {};
    if (typeof details.projectId !== 'string' || !PROJECT_ID_PATTERN.test(details.projectId)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '计划缺少有效的 projectId。');
    }
    const discovered = await discoverTemplates(context.fs);
    const entry = findTemplate(discovered.entries, input.templateId);
    const template = entry.template;
    const templateHash = hashJson(template);
    if (template.revision !== input.expectedTemplateRevision
      || template.revision !== plan.expectedTemplateRevision) {
      throw new AppError(ERROR_CODES.CONFLICT, '模板版本已变化，请重新预览。');
    }
    if (details.templateHash !== templateHash) {
      throw new AppError(ERROR_CODES.CONFLICT, '模板内容已变化，请重新预览。');
    }
    validateSlug(details.slug, context.config.slugRules);
    if (details.relativePath !== `${projectsPath(context)}/${details.slug}`) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '计划中的项目路径与 slug 不一致。');
    }
    verifyPlan(plan, {
      kind: 'project.create',
      input,
      expectedConfigRevision: context.config.configRevision,
      expectedTemplateRevision: template.revision,
      target: {
        projectId: details.projectId,
        slug: details.slug,
        relativePath: details.relativePath,
        templateId: template.id,
        templateHash
      }
    });
    if (Array.isArray(details.conflicts) && details.conflicts.length > 0) {
      throw new AppError(ERROR_CODES.CONFLICT, details.conflicts[0].message || '计划存在冲突。', {
        details: { conflicts: details.conflicts }
      });
    }
    const fieldValues = normalizeFieldValues(template, input.fieldValues);

    const existingOperation = await context.journal.get(plan.operationId);
    if (existingOperation) {
      return handleExistingCreateOperation(context, plan, existingOperation, template);
    }

    await context.templateIndex.sync(context.config.rootId, discovered.entries);
    await assertLocationFree(context, details.relativePath, details.slug);
    const record = {
      projectId: details.projectId,
      rootId: context.config.rootId,
      templateId: template.id,
      templateRevision: template.revision,
      slug: details.slug,
      displayName: input.displayName,
      relativePath: details.relativePath,
      status: 'provisioning',
      fieldValues,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const projectPath = toAbsolute(context.rootPath, record.relativePath);
    let started = false;
    try {
      await context.journal.begin(createOperationRecord({
        operationId: plan.operationId,
        rootId: context.config.rootId,
        kind: 'project.create',
        state: 'applying',
        projectId: record.projectId,
        targetRelativePath: record.relativePath,
        payload: { input, plan },
        completedSteps: []
      }));
      started = true;
      await context.fs.createDirectoryExclusive(record.relativePath);
      for (const directory of template.directoryBlueprint) {
        await context.fs.createDirectoryTree(`${record.relativePath}/${directory}`);
      }
      await context.fs.writeFileExclusive(
        `${record.relativePath}/${SNAPSHOT_FILE}`,
        `${JSON.stringify(projectSnapshot(record), null, 2)}\n`
      );
      await context.repo.insert(record);
      await context.journal.transition(plan.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['directory_created', 'blueprint_created', 'snapshot_written', 'database_inserted'],
        payload: { input, plan, projectId: record.projectId }
      });
      return pendingResult(plan.operationId, record, projectPath);
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
 * @param {object} template
 * @returns {Promise<object>}
 */
async function handleExistingCreateOperation(context, plan, operation, template) {
  if (operation.kind !== 'project.create') {
    throw new AppError(ERROR_CODES.CONFLICT, 'operationId 已被其他操作占用。');
  }
  if (operation.projectId && operation.projectId !== plan.details.projectId) {
    throw new AppError(ERROR_CODES.CONFLICT, '操作对应的项目与计划不一致。');
  }
  const project = operation.projectId ? await context.repo.getById(operation.projectId) : null;
  if (operation.state === 'completed') {
    if (!project) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '操作已完成但项目记录缺失。');
    return {
      operationId: operation.operationId,
      state: 'completed',
      changedPaths: [],
      requiresWorkspaceSync: false,
      warnings: [{
        code: 'ALREADY_CREATED',
        severity: 'info',
        message: '该项目已创建并完成工作区同步，未重复写入。'
      }],
      project: projectSummary(project)
    };
  }
  if (operation.state === 'awaiting_workspace') {
    if (!project) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '待同步项目记录缺失。');
    return pendingResult(operation.operationId, project, toAbsolute(context.rootPath, project.relativePath));
  }
  if (operation.state === 'applying') {
    if (!project) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目创建中断且数据库记录缺失，需要人工恢复。');
    }
    const info = await context.fs.inspect(project.relativePath);
    const snapshot = await context.fs.inspect(`${project.relativePath}/${SNAPSHOT_FILE}`);
    if (!info.exists || info.type !== 'directory' || !snapshot.exists) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目目录或元数据快照缺失，需要人工恢复。');
    }
    await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
      completedSteps: ['recovered_after_interruption']
    });
    return pendingResult(operation.operationId, project, toAbsolute(context.rootPath, project.relativePath));
  }
  if (operation.state === 'needs_recovery') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '该项目创建操作需要人工恢复。', {
      operationId: operation.operationId
    });
  }
  throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `操作状态 ${operation.state} 不能继续创建。`);
}


/**
 * @param {object} context
 * @param {string} relativePath
 * @param {string} slug
 */
async function assertLocationFree(context, relativePath, slug) {
  const bySlug = await context.repo.getBySlug(context.config.rootId, slug);
  const byPath = await context.repo.getByRelativePath(context.config.rootId, relativePath);
  const info = await context.fs.inspect(relativePath);
  if (bySlug || byPath || info.exists) {
    throw new AppError(ERROR_CODES.CONFLICT, `项目路径已被占用：${relativePath}`, {
      details: { relativePath, slug }
    });
  }
}

/**
 * @param {object} context
 * @returns {string}
 */
function projectsPath(context) {
  const partition = context.config.partitions.find((item) => item.id === 'projects');
  return partition.relativePath;
}

/**
 * @param {string} rootPath
 * @param {string} relativePath
 * @returns {string}
 */
function toAbsolute(rootPath, relativePath) {
  return path.join(rootPath, ...relativePath.split('/'));
}

/**
 * @param {string} operationId
 * @param {object} record
 * @param {string} projectPath
 * @returns {object}
 */
function pendingResult(operationId, record, projectPath) {
  return {
    operationId,
    state: 'awaiting_workspace',
    changedPaths: [record.relativePath],
    requiresWorkspaceSync: true,
    warnings: [],
    project: projectSummary(record),
    workspaceSync: {
      operationId,
      action: 'add',
      targetUri: pathToFileUri(projectPath),
      displayName: record.displayName,
      observedPresent: false
    }
  };
}

/**
 * @param {unknown} payload
 */
function assertExecutePayload(payload) {
  assertObject(payload, 'project.create.execute');
  assertOnlyKeys(payload, ['plan', 'input'], 'project.create.execute');
  if (!payload.input) throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 input。');
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!isPlainObject(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 的 payload 必须是对象。`);
  }
}

/**
 * @param {object} object
 * @param {string[]} allowed
 * @param {string} label
 */
function assertOnlyKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含未知字段：${key}`);
    }
  }
}

module.exports = {
  executeProjectCreation,
  assertLocationFree,
  projectsPath,
  toAbsolute,
  pendingResult
};

'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const {
  normalizeFileUri,
  normalizeRelativePath,
  pathToFileUri
} = require('../shared/paths');
const { newOperationId, newPlanId, nowIso } = require('../shared/ids');
const { partitionById } = require('../domain/root-config');
const { assertProjectStatusTransition } = require('../domain/project');
const { createPlan, verifyPlan } = require('../domain/plan');
const { createOperationRecord } = require('../domain/operation');
const { withRootContext } = require('./context');
const { assertRootId } = require('./template-service');

const INPUT_KEYS = ['rootUri', 'rootId', 'projectId', 'targetPartitionId'];

/**
 * @param {unknown} payload
 */
function normalizeArchiveInput(payload) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '归档输入必须是 JSON 对象。');
  }
  for (const key of Object.keys(payload)) {
    if (!INPUT_KEYS.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `归档输入包含未知字段：${key}`);
    }
  }
  if (typeof payload.projectId !== 'string' || !payload.projectId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'projectId 不能为空。');
  }
  const targetPartitionId = payload.targetPartitionId === undefined ? 'archive' : payload.targetPartitionId;
  if (targetPartitionId !== 'archive') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '首期只支持归档到 archive 分区。');
  }
  return {
    rootUri: normalizeFileUri(payload.rootUri),
    rootId: payload.rootId,
    projectId: payload.projectId,
    targetPartitionId
  };
}

/**
 * @param {unknown} payload
 * @returns {Promise<object>}
 */
async function planArchive(payload) {
  const input = normalizeArchiveInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    if (!project) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目不存在：${input.projectId}`);
    if (project.status !== 'active') {
      throw new AppError(ERROR_CODES.CONFLICT, `只有 active 项目可以归档，当前状态为 ${project.status}。`);
    }
    const archivePath = partitionById(context.config, 'archive').relativePath;
    const targetRelativePath = normalizeRelativePath(`${archivePath}/${project.slug}`, {
      label: '归档目标路径'
    });
    const targetInfo = await context.fs.inspect(targetRelativePath);
    const byPath = await context.repo.getByRelativePath(context.config.rootId, targetRelativePath);
    const conflict = targetInfo.exists || Boolean(byPath);
    const warnings = conflict ? [{
      code: 'TARGET_EXISTS',
      severity: 'error',
      message: `归档目标已存在，操作已阻止：${targetRelativePath}`
    }] : [];
    return createPlan({
      kind: 'project.archive',
      planId: newPlanId(),
      operationId: newOperationId(),
      input,
      expectedConfigRevision: context.config.configRevision,
      target: {
        projectId: project.projectId,
        sourceRelativePath: project.relativePath,
        targetRelativePath
      },
      summary: {
        title: '归档项目',
        lines: [
          `项目：${project.displayName} (${project.slug})`,
          `源路径：${project.relativePath}`,
          `目标路径：${targetRelativePath}`,
          '归档会移动项目目录并从当前工作区移除对应文件夹。'
        ],
        warnings
      },
      details: {
        projectId: project.projectId,
        sourceRelativePath: project.relativePath,
        targetRelativePath,
        conflict
      }
    });
  });
}

/**
 * @param {{plan: object, input: object}} payload
 * @returns {Promise<object>}
 */
async function executeArchive(payload) {
  if (!isPlainObject(payload) || !payload.plan || !payload.input) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '执行归档需要 plan 和 input。');
  }
  const input = normalizeArchiveInput(payload.input);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    if (!project) throw new AppError(ERROR_CODES.CONFLICT, `项目不存在：${input.projectId}`);
    if (project.status !== 'active') {
      throw new AppError(ERROR_CODES.CONFLICT, `只有 active 项目可以归档，当前状态为 ${project.status}。`);
    }
    const archivePath = partitionById(context.config, 'archive').relativePath;
    const targetRelativePath = normalizeRelativePath(`${archivePath}/${project.slug}`, {
      label: '归档目标路径'
    });
    verifyPlan(payload.plan, {
      kind: 'project.archive',
      input,
      expectedConfigRevision: context.config.configRevision,
      target: {
        projectId: project.projectId,
        sourceRelativePath: project.relativePath,
        targetRelativePath
      }
    });
    const existing = await context.journal.get(payload.plan.operationId);
    if (existing) return handleExistingArchive(context, payload.plan, existing, project, targetRelativePath);
    if (payload.plan.details?.conflict) {
      throw new AppError(ERROR_CODES.CONFLICT, '归档目标已存在，操作已阻止。');
    }
    const targetInfo = await context.fs.inspect(targetRelativePath);
    if (targetInfo.exists) throw new AppError(ERROR_CODES.CONFLICT, '归档目标已存在。');
    const oldAbsolute = path.join(context.rootPath, ...project.relativePath.split('/'));

    let started = false;
    try {
      await context.journal.begin(createOperationRecord({
        operationId: payload.plan.operationId,
        rootId: context.config.rootId,
        kind: 'project.archive',
        state: 'applying',
        projectId: project.projectId,
        sourceRelativePath: project.relativePath,
        targetRelativePath,
        payload: { input, plan: payload.plan },
        completedSteps: []
      }));
      started = true;
      await context.fs.createDirectoryTree(archivePath);
      await context.fs.moveNoReplace(project.relativePath, targetRelativePath);
      assertProjectStatusTransition(project.status, 'archiving');
      const updated = {
        ...project,
        relativePath: targetRelativePath,
        status: 'archiving',
        updatedAt: nowIso()
      };
      await context.repo.update(updated, project.updatedAt);
      await context.journal.transition(payload.plan.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['directory_moved', 'database_updated']
      });
      return {
        operationId: payload.plan.operationId,
        state: 'awaiting_workspace',
        changedPaths: [project.relativePath, targetRelativePath],
        requiresWorkspaceSync: true,
        warnings: [],
        project: updated,
        workspaceSync: {
          operationId: payload.plan.operationId,
          action: 'remove',
          targetUri: pathToFileUri(oldAbsolute),
          displayName: project.displayName,
          observedPresent: true
        }
      };
    } catch (error) {
      if (started) {
        try {
          await context.journal.markNeedsRecovery(payload.plan.operationId, 'applying', error.message);
        } catch { /* 保留原始错误 */ }
      }
      const appError = normalizeError(error);
      appError.operationId = payload.plan.operationId;
      throw appError;
    }
  });
}

/**
 * @param {object} context
 * @param {object} plan
 * @param {object} operation
 * @param {object} project
 * @param {string} targetRelativePath
 */
async function handleExistingArchive(context, plan, operation, project, targetRelativePath) {
  if (operation.kind !== 'project.archive') {
    throw new AppError(ERROR_CODES.CONFLICT, 'operationId 已被其他操作占用。');
  }
  if (operation.state === 'completed') {
    return {
      operationId: operation.operationId,
      state: 'completed',
      changedPaths: [],
      requiresWorkspaceSync: false,
      warnings: [{ code: 'ALREADY_ARCHIVED', severity: 'info', message: '项目已归档。' }],
      project
    };
  }
  if (operation.state === 'awaiting_workspace') {
    const oldAbsolute = path.join(context.rootPath, ...operation.sourceRelativePath.split('/'));
    return {
      operationId: operation.operationId,
      state: 'awaiting_workspace',
      changedPaths: [],
      requiresWorkspaceSync: true,
      warnings: [],
      project,
      workspaceSync: {
        operationId: operation.operationId,
        action: 'remove',
        targetUri: pathToFileUri(oldAbsolute),
        displayName: project.displayName,
        observedPresent: true
      }
    };
  }
  if (operation.state === 'applying') {
    const oldRelativePath = operation.sourceRelativePath;
    const oldAbsolute = path.join(context.rootPath, ...oldRelativePath.split('/'));
    const sourceExists = (await context.fs.inspect(oldRelativePath)).exists;
    const targetExists = (await context.fs.inspect(targetRelativePath)).exists;
    if (project.relativePath === targetRelativePath && targetExists && !sourceExists) {
      await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['recovered_after_interruption']
      });
      return {
        operationId: operation.operationId,
        state: 'awaiting_workspace',
        changedPaths: [],
        requiresWorkspaceSync: true,
        warnings: [],
        project,
        workspaceSync: {
          operationId: operation.operationId,
          action: 'remove',
          targetUri: pathToFileUri(oldAbsolute),
          displayName: project.displayName,
          observedPresent: true
        }
      };
    }
    if (!sourceExists && targetExists && project.relativePath === oldRelativePath) {
      const updated = {
        ...project,
        relativePath: targetRelativePath,
        status: 'archiving',
        updatedAt: nowIso()
      };
      await context.repo.update(updated, project.updatedAt);
      await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['recovered_after_interruption']
      });
      return {
        operationId: operation.operationId,
        state: 'awaiting_workspace',
        changedPaths: [oldRelativePath, targetRelativePath],
        requiresWorkspaceSync: true,
        warnings: [],
        project: updated,
        workspaceSync: {
          operationId: operation.operationId,
          action: 'remove',
          targetUri: pathToFileUri(oldAbsolute),
          displayName: project.displayName,
          observedPresent: true
        }
      };
    }
  }
  throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '归档操作需要人工恢复。', {
    operationId: operation.operationId
  });
}
module.exports = {
  normalizeArchiveInput,
  planArchive,
  executeArchive
};

'use strict';

const path = require('node:path');
const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { normalizeFileUri, pathToFileUri, sameFileUri } = require('../shared/paths');
const { nowIso } = require('../shared/ids');
const { projectSummary, assertProjectStatusTransition } = require('../domain/project');
const { withRootContext } = require('./context');
const { assertRootId } = require('./template-service');

/**
 * 完成由扩展宿主观察到的 Workspace API 结果。
 * action=add 用于 project.create，action=remove 用于 project.archive。
 * @param {{rootUri: string, rootId?: string, operationId: string, observedPresent: boolean, action?: string, targetUri: string}} payload
 * @returns {Promise<object>}
 */
async function completeWorkspaceSync(payload) {
  assertObject(payload, 'project.workspace.complete');
  const allowed = ['rootUri', 'rootId', 'operationId', 'observedPresent', 'action', 'targetUri'];
  assertOnlyKeys(payload, allowed, 'project.workspace.complete');
  const rootUri = normalizeFileUri(payload.rootUri);
  if (typeof payload.operationId !== 'string' || !payload.operationId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '缺少 operationId。');
  }
  if (typeof payload.observedPresent !== 'boolean') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'observedPresent 必须是布尔值。');
  }
  const action = payload.action === undefined ? 'add' : payload.action;
  if (!['add', 'remove'].includes(action)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'action 必须是 add 或 remove。');
  }
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    const operation = await context.journal.get(payload.operationId);
    if (!operation) throw new AppError(ERROR_CODES.CONFLICT, '操作不存在。');
    const project = operation.projectId ? await context.repo.getById(operation.projectId) : null;
    if (!project) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目记录缺失，无法完成同步。');
    if (operation.state === 'completed') {
      return {
        operationId: operation.operationId,
        state: 'completed',
        changedPaths: [],
        requiresWorkspaceSync: false,
        warnings: [],
        project: projectSummary(project)
      };
    }
    if (operation.state === 'needs_recovery') {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '操作需要人工恢复。', {
        operationId: operation.operationId
      });
    }
    if (action === 'add') {
      if (operation.kind === 'project.restore') {
        return completeRestore(context, payload, operation, project);
      }
      return completeCreate(context, payload, operation, project);
    }
    return completeArchive(context, payload, operation, project);
  });
}

async function completeRestore(context, payload, operation, project) {
  if (operation.state !== 'awaiting_workspace') {
    throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `操作当前状态为 ${operation.state}。`);
  }
  if (!operation.targetRelativePath || project.relativePath !== operation.targetRelativePath) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '恢复操作目标路径与项目台账不一致。');
  }
  const targetPath = toAbsolute(context.rootPath, operation.targetRelativePath);
  if (typeof payload.targetUri === 'string' && !sameFileUri(payload.targetUri, pathToFileUri(targetPath))) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'targetUri 与恢复后的项目路径不一致。');
  }
  const info = await context.fs.inspect(operation.targetRelativePath);
  if (!info.exists || info.type !== 'directory') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '恢复后的项目目录缺失。');
  }
  if (!payload.observedPresent) {
    return {
      operationId: operation.operationId,
      state: 'awaiting_workspace',
      changedPaths: [],
      requiresWorkspaceSync: true,
      warnings: [{ code: 'WORKSPACE_FOLDER_MISSING', severity: 'warning', message: '工作区中尚未观察到恢复的项目文件夹。' }],
      project: projectSummary(project)
    };
  }
  let updated = project;
  if (project.status !== 'active') {
    assertProjectStatusTransition(project.status, 'active');
    updated = { ...project, status: 'active', updatedAt: nowIso() };
    await context.repo.update(updated, project.updatedAt);
  }
  await context.journal.transition(operation.operationId, 'awaiting_workspace', 'completed', {
    completedSteps: ['workspace_folder_observed', 'project_active']
  });
  return {
    operationId: operation.operationId,
    state: 'completed',
    changedPaths: [],
    requiresWorkspaceSync: false,
    warnings: [],
    project: projectSummary(updated)
  };
}

/**
 * @param {object} context
 * @param {object} payload
 * @param {object} operation
 * @param {object} project
 */
async function completeCreate(context, payload, operation, project) {
  if (operation.kind !== 'project.create') {
    throw new AppError(ERROR_CODES.CONFLICT, 'action=add 只能用于 project.create 操作。');
  }
  const projectPath = toAbsolute(context.rootPath, project.relativePath);
  if (typeof payload.targetUri === 'string' && !sameFileUri(payload.targetUri, pathToFileUri(projectPath))) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'targetUri 与项目路径不一致。');
  }
  if (operation.state !== 'awaiting_workspace') {
    throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `操作当前状态为 ${operation.state}。`);
  }
  const info = await context.fs.inspect(project.relativePath);
  if (!info.exists || info.type !== 'directory') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目目录缺失，无法完成工作区同步。');
  }
  if (!payload.observedPresent) {
    return {
      operationId: operation.operationId,
      state: 'awaiting_workspace',
      changedPaths: [],
      requiresWorkspaceSync: true,
      warnings: [{
        code: 'WORKSPACE_FOLDER_MISSING',
        severity: 'warning',
        message: '目标工作区中尚未观察到该项目文件夹，请重试同步。'
      }],
      project: projectSummary(project)
    };
  }
  if (project.status !== 'active') {
    assertProjectStatusTransition(project.status, 'active');
    const updated = { ...project, status: 'active', updatedAt: nowIso() };
    await context.repo.update(updated, project.updatedAt);
  }
  await context.journal.transition(operation.operationId, 'awaiting_workspace', 'completed', {
    completedSteps: ['workspace_folder_observed', 'project_active']
  });
  const latest = await context.repo.getById(project.projectId);
  return {
    operationId: operation.operationId,
    state: 'completed',
    changedPaths: [],
    requiresWorkspaceSync: false,
    warnings: [],
    project: projectSummary(latest || project)
  };
}

/**
 * @param {object} context
 * @param {object} payload
 * @param {object} operation
 * @param {object} project
 */
async function completeArchive(context, payload, operation, project) {
  if (operation.kind !== 'project.archive') {
    throw new AppError(ERROR_CODES.CONFLICT, 'action=remove 只能用于 project.archive 操作。');
  }
  if (!operation.sourceRelativePath || !operation.targetRelativePath) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '归档操作缺少源或目标路径。');
  }
  const oldPath = toAbsolute(context.rootPath, operation.sourceRelativePath);
  if (typeof payload.targetUri === 'string' && !sameFileUri(payload.targetUri, pathToFileUri(oldPath))) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'targetUri 与归档前路径不一致。');
  }
  if (operation.state !== 'awaiting_workspace') {
    throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `操作当前状态为 ${operation.state}。`);
  }
  if (project.relativePath !== operation.targetRelativePath) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目台账路径与归档目标不一致。');
  }
  const archivedInfo = await context.fs.inspect(operation.targetRelativePath);
  if (!archivedInfo.exists || archivedInfo.type !== 'directory') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '归档目录缺失，无法完成归档。');
  }
  if (payload.observedPresent) {
    return {
      operationId: operation.operationId,
      state: 'awaiting_workspace',
      changedPaths: [],
      requiresWorkspaceSync: true,
      warnings: [{
        code: 'WORKSPACE_FOLDER_PRESENT',
        severity: 'warning',
        message: '工作区中仍观察到旧文件夹，请移除后重试。'
      }],
      project: projectSummary(project)
    };
  }
  if (project.status !== 'archived') {
    assertProjectStatusTransition(project.status, 'archived');
    const updated = { ...project, status: 'archived', updatedAt: nowIso() };
    await context.repo.update(updated, project.updatedAt);
  }
  await context.journal.transition(operation.operationId, 'awaiting_workspace', 'completed', {
    completedSteps: ['workspace_folder_removed', 'project_archived']
  });
  const latest = await context.repo.getById(project.projectId);
  return {
    operationId: operation.operationId,
    state: 'completed',
    changedPaths: [],
    requiresWorkspaceSync: false,
    warnings: [],
    project: projectSummary(latest || project)
  };
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
  completeWorkspaceSync
};

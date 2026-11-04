'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { normalizeFileUri, normalizeRelativePath, pathToFileUri } = require('../shared/paths');
const { newOperationId, newPlanId, nowIso } = require('../shared/ids');
const { partitionById } = require('../domain/root-config');
const { createPlan, verifyPlan } = require('../domain/plan');
const { createOperationRecord } = require('../domain/operation');
const { withRootContext } = require('./context');
const { assertRootId } = require('./template-service');

const INPUT_KEYS = ['rootUri', 'rootId', 'projectId'];

function normalizeRestoreInput(payload) {
  if (!isPlainObject(payload)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '恢复输入必须是 JSON 对象。');
  for (const key of Object.keys(payload)) {
    if (!INPUT_KEYS.includes(key)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `恢复输入包含未知字段：${key}`);
  }
  if (typeof payload.projectId !== 'string' || !payload.projectId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'projectId 不能为空。');
  }
  return { rootUri: normalizeFileUri(payload.rootUri), rootId: payload.rootId, projectId: payload.projectId };
}

async function planRestore(payload) {
  const input = normalizeRestoreInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    assertArchived(project, input.projectId);
    const source = project.relativePath;
    const archive = partitionById(context.config, 'archive').relativePath;
    const projects = partitionById(context.config, 'projects').relativePath;
    if (!source.startsWith(`${archive}/`)) {
      throw new AppError(ERROR_CODES.CONFLICT, '项目台账路径不在归档分区，不能恢复。');
    }
    const target = normalizeRelativePath(`${projects}/${project.slug}`, { label: '恢复目标路径' });
    const targetInfo = await context.fs.inspect(target);
    const indexed = await context.repo.getByRelativePath(context.config.rootId, target);
    const conflict = targetInfo.exists || Boolean(indexed && indexed.projectId !== project.projectId);
    return createPlan({
      kind: 'project.restore', planId: newPlanId(), operationId: newOperationId(), input,
      expectedConfigRevision: context.config.configRevision,
      target: { projectId: project.projectId, sourceRelativePath: source, targetRelativePath: target },
      summary: {
        title: '恢复归档项目',
        lines: [`项目：${project.displayName} (${project.slug})`, `归档路径：${source}`,
          `恢复路径：${target}`, '恢复会将目录移回项目分区并重新加入当前工作区。'],
        warnings: conflict ? [{ code: 'TARGET_EXISTS', severity: 'error', message: `恢复目标已存在：${target}` }] : []
      },
      details: { projectId: project.projectId, sourceRelativePath: source, targetRelativePath: target, conflict }
    });
  });
}

async function executeRestore(payload) {
  if (!isPlainObject(payload) || !payload.plan || !payload.input) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '执行恢复需要 plan 和 input。');
  }
  for (const key of Object.keys(payload)) {
    if (!['plan', 'input'].includes(key)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `执行恢复包含未知字段：${key}`);
  }
  const input = normalizeRestoreInput(payload.input);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const project = await context.repo.getById(input.projectId);
    assertArchived(project, input.projectId);
    const source = project.relativePath;
    const target = normalizeRelativePath(
      `${partitionById(context.config, 'projects').relativePath}/${project.slug}`, { label: '恢复目标路径' }
    );
    verifyPlan(payload.plan, {
      kind: 'project.restore', input, expectedConfigRevision: context.config.configRevision,
      target: { projectId: project.projectId, sourceRelativePath: source, targetRelativePath: target }
    });
    const existing = await context.journal.get(payload.plan.operationId);
    if (existing) return resumeRestore(context, existing, project, source, target);
    if (payload.plan.details?.conflict) throw new AppError(ERROR_CODES.CONFLICT, '恢复目标已存在，操作已阻止。');
    const sourceInfo = await context.fs.inspect(source);
    const targetInfo = await context.fs.inspect(target);
    if (!sourceInfo.exists || sourceInfo.type !== 'directory' || targetInfo.exists) {
      throw new AppError(ERROR_CODES.CONFLICT, '归档源缺失或恢复目标已存在，未执行恢复。');
    }
    await context.journal.begin(createOperationRecord({
      operationId: payload.plan.operationId, rootId: context.config.rootId, kind: 'project.restore',
      state: 'applying', projectId: project.projectId, sourceRelativePath: source,
      targetRelativePath: target, payload: { input, plan: payload.plan }, completedSteps: []
    }));
    try {
      await moveAndAwait(context, payload.plan.operationId, project, source, target);
      return workspaceResult(context, payload.plan.operationId, project, source, target);
    } catch (error) {
      await context.journal.markNeedsRecovery(payload.plan.operationId, 'applying', error.message).catch(() => {});
      const appError = normalizeError(error);
      appError.operationId = payload.plan.operationId;
      throw appError;
    }
  });
}

async function resumeRestore(context, operation, project, source, target) {
  if (operation.kind !== 'project.restore') throw new AppError(ERROR_CODES.CONFLICT, 'operationId 已被其他操作占用。');
  if (operation.state === 'completed') return { operationId: operation.operationId, state: 'completed', requiresWorkspaceSync: false };
  if (operation.state === 'awaiting_workspace') return workspaceResult(context, operation.operationId, project, source, target);
  if (operation.state === 'needs_recovery') {
    await context.journal.transition(operation.operationId, 'needs_recovery', 'applying');
  } else if (operation.state !== 'applying') {
    throw new AppError(ERROR_CODES.OPERATION_INCOMPLETE, `恢复操作状态为 ${operation.state}。`);
  }
  const sourceInfo = await context.fs.inspect(source);
  const targetInfo = await context.fs.inspect(target);
  if (sourceInfo.exists && targetInfo.exists) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '归档源和恢复目标同时存在，需要人工检查。');
  if (!sourceInfo.exists && !targetInfo.exists) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '归档源和恢复目标均不存在，需要人工检查。');
  if (sourceInfo.exists) await context.fs.moveNoReplace(source, target);
  await syncProjectPath(context, project, source, target);
  await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
    completedSteps: ['directory_moved', 'database_updated']
  });
  return workspaceResult(context, operation.operationId, project, source, target);
}

async function moveAndAwait(context, operationId, project, source, target) {
  const partition = partitionById(context.config, 'projects').relativePath;
  await context.fs.createDirectoryTree(partition);
  await context.fs.moveNoReplace(source, target);
  await syncProjectPath(context, project, source, target);
  await context.journal.transition(operationId, 'applying', 'awaiting_workspace', {
    completedSteps: ['directory_moved', 'database_updated']
  });
}

async function syncProjectPath(context, project, source, target) {
  const latest = await context.repo.getById(project.projectId);
  if (!latest) throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '恢复期间项目记录丢失。');
  if (latest.relativePath === target) return;
  if (latest.relativePath !== source || latest.status !== 'archived') {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '项目台账已变化，停止恢复。');
  }
  await context.repo.update({ ...latest, relativePath: target, updatedAt: nowIso() }, latest.updatedAt);
}

function workspaceResult(context, operationId, project, source, target) {
  return {
    operationId, state: 'awaiting_workspace', changedPaths: [source, target],
    requiresWorkspaceSync: true, warnings: [],
    project: { ...project, relativePath: target },
    workspaceSync: {
      operationId, action: 'add', targetUri: pathToFileUri(path.join(context.rootPath, ...target.split('/'))),
      displayName: project.displayName, observedPresent: false
    }
  };
}

function assertArchived(project, projectId) {
  if (!project) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目不存在：${projectId}`);
  if (project.status !== 'archived') throw new AppError(ERROR_CODES.CONFLICT, `只有 archived 项目可以恢复，当前状态为 ${project.status}。`);
}

module.exports = { normalizeRestoreInput, planRestore, executeRestore };

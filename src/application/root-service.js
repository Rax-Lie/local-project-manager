'use strict';

const { AppError, normalizeError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { fileUriToPath, sameFileUri } = require('../shared/paths');
const { createRootConfig } = require('../domain/root-config');
const { verifyPlan } = require('../domain/plan');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const { DEFAULT_TEMPLATES } = require('./defaults');
const { serializeTemplate, openRootContext } = require('./context');
const { inspectRoot } = require('./root-inspect');
const { createRootBootstrap, writeRootBootstrap, crashAtBootstrapPoint } = require('./root-bootstrap');
const { applyRootBootstrap } = require('./root-bootstrap-apply');
const {
  normalizeInitializationInput,
  rootIdFromPlan,
  assertRootDirectory
} = require('./root-plan');

/**
 * @param {{input: object, plan: object}} payload
 * @returns {Promise<object>}
 */
async function executeRootInitialization(payload) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '执行初始化需要 input 和 plan。');
  }
  for (const key of Object.keys(payload)) {
    if (!['input', 'plan'].includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `执行初始化包含未知字段：${key}`);
    }
  }
  if (!payload.plan) throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 ConfirmedPlan。');
  const normalized = normalizeInitializationInput(payload.input);
  const inspection = await inspectRoot({ rootUri: normalized.rootUri });
  assertRootDirectory(inspection);
  const rootId = rootIdFromPlan(payload.plan);

  if (inspection.initialized && !inspection.partial) {
    if (!sameFileUri(inspection.config.workspaceUri, normalized.workspaceUri)) {
      throw new AppError(ERROR_CODES.CONFLICT, '管理根已绑定其他工作区。');
    }
    const already = Boolean(payload.plan.details?.alreadyInitialized);
    verifyPlan(payload.plan, {
      kind: 'root.initialize',
      input: normalized,
      expectedConfigRevision: already ? inspection.config.configRevision : 1,
      target: {
        rootUri: normalized.rootUri,
        workspaceUri: normalized.workspaceUri,
        rootId
      }
    });
    if (inspection.config.rootId !== rootId) {
      throw new AppError(ERROR_CODES.CONFLICT, '计划中的根 ID 与现有配置不一致。');
    }
    return finalizeExistingInitialization({
      plan: payload.plan,
      inspection,
      normalized,
      rootId
    });
  }
  if (inspection.partial) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '管理根存在未完成的初始化，已停止执行。');
  }
  if (!inspection.isEmpty) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '根目录不是空目录，已停止初始化。');
  }

  verifyPlan(payload.plan, {
    kind: 'root.initialize',
    input: normalized,
    expectedConfigRevision: 1,
    target: {
      rootUri: normalized.rootUri,
      workspaceUri: normalized.workspaceUri,
      rootId,
      partitions: normalized.partitions,
      slugRules: normalized.slugRules
    }
  });
  if (payload.plan.details?.blocking) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '计划已标记为阻塞，不能执行。');
  }

  const config = createRootConfig({
    rootId,
    displayName: normalized.displayName,
    workspaceUri: normalized.workspaceUri,
    partitions: normalized.partitions,
    slugRules: normalized.slugRules
  });
  const templateFiles = DEFAULT_TEMPLATES.map((template) => serializeTemplate(template));
  const fsPort = new SafeFileSystem(fileUriToPath(normalized.rootUri));
  const bootstrap = createRootBootstrap({
    operationId: payload.plan.operationId,
    rootId,
    input: normalized,
    config,
    templateFiles,
    changedPaths: payload.plan.details?.changedPaths || []
  });
  try {
    await writeRootBootstrap(fsPort, bootstrap);
    crashAtBootstrapPoint('bootstrap_marker');
    return await applyRootBootstrap(bootstrap);
  } catch (error) {
    const appError = normalizeError(error);
    appError.operationId = payload.plan.operationId;
    throw appError;
  }
}

/**
 * @param {{plan: object, inspection: object, normalized: object, rootId: string}} params
 * @returns {Promise<object>}
 */
async function finalizeExistingInitialization({ plan, inspection, normalized, rootId }) {
  const warnings = [];
  warnings.push({
    code: 'ALREADY_INITIALIZED',
    severity: 'info',
    message: plan.details?.alreadyInitialized
      ? '管理根已初始化，未重复写入任何文件。'
      : '检测到初始化已完成，已按幂等语义返回，未重复写入。'
  });
  let context;
  try {
    context = await openRootContext(normalized.rootUri);
    const operation = await context.journal.get(plan.operationId);
    if (operation && operation.state === 'applying') {
      await context.journal.transition(operation.operationId, 'applying', 'completed', {
        completedSteps: ['recovered_after_initialization']
      });
    } else if (operation && operation.state === 'needs_recovery') {
      warnings.push({
        code: 'OPERATION_NEEDS_RECOVERY',
        severity: 'warning',
        message: '初始化操作日志仍标记为需要恢复，请运行“检查未完成操作”。'
      });
    }
  } finally {
    if (context) context.close();
  }
  return {
    operationId: plan.operationId,
    state: 'completed',
    changedPaths: [],
    requiresWorkspaceSync: false,
    warnings,
    config: inspection.config,
    rootId
  };
}

module.exports = {
  executeRootInitialization
};

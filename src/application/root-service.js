'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const {
  ERROR_CODES,
  PM_DIR,
  TEMPLATES_DIR,
  BACKUPS_DIR,
  DB_FILE
} = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { fileUriToPath, sameFileUri } = require('../shared/paths');
const { createRootConfig, serializeRootConfig } = require('../domain/root-config');
const { verifyPlan } = require('../domain/plan');
const { createOperationRecord } = require('../domain/operation');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const { SqliteDatabase } = require('../adapters/sqlite/database');
const { OperationJournal } = require('../adapters/sqlite/operation-journal');
const { TemplateIndex } = require('../adapters/sqlite/template-index');
const { DEFAULT_TEMPLATES } = require('./defaults');
const { inspectRoot } = require('./root-inspect');
const {
  CONFIG_RELATIVE_PATH,
  discoverTemplates,
  serializeTemplate,
  openRootContext
} = require('./context');
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
  const fsPort = new SafeFileSystem(fileUriToPath(normalized.rootUri));
  const dbPath = path.join(fileUriToPath(normalized.rootUri), PM_DIR, DB_FILE);
  let db;
  let journal;
  let started = false;
  try {
    await fsPort.createDirectoryExclusive(PM_DIR);
    db = new SqliteDatabase(dbPath);
    await db.open();
    journal = new OperationJournal(db);
    await journal.begin(createOperationRecord({
      operationId: payload.plan.operationId,
      rootId,
      kind: 'root.initialize',
      state: 'applying',
      payload: { input: normalized, planId: payload.plan.planId },
      completedSteps: []
    }));
    started = true;
    await fsPort.createDirectoryExclusive(`${PM_DIR}/${TEMPLATES_DIR}`);
    await fsPort.createDirectoryExclusive(`${PM_DIR}/${BACKUPS_DIR}`);
    for (const partition of config.partitions) {
      await fsPort.createDirectoryTree(partition.relativePath);
    }
    await fsPort.writeFileExclusive(CONFIG_RELATIVE_PATH, serializeRootConfig(config));
    const templateEntries = DEFAULT_TEMPLATES.map((template) => serializeTemplate(template));
    for (const entry of templateEntries) {
      await fsPort.writeFileExclusive(entry.relativePath, entry.content);
    }
    const discovered = await discoverTemplates(fsPort);
    if (discovered.diagnostics.some((item) => item.severity === 'error')) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '内置模板写入后校验失败。');
    }
    await new TemplateIndex(db).sync(rootId, discovered.entries);
    const check = db.quickCheck();
    if (!check.ok) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `数据库完整性检查失败：${check.messages.join('; ')}`);
    }
    await journal.transition(payload.plan.operationId, 'applying', 'completed', {
      completedSteps: [
        'pm_directory',
        'database',
        'partitions',
        'config',
        'templates',
        'template_index',
        'integrity_check'
      ]
    });
    return {
      operationId: payload.plan.operationId,
      state: 'completed',
      changedPaths: payload.plan.details?.changedPaths || [],
      requiresWorkspaceSync: false,
      warnings: [],
      config
    };
  } catch (error) {
    if (started && journal) {
      try {
        await journal.markNeedsRecovery(payload.plan.operationId, 'applying', error.message);
      } catch { /* 保留原始错误 */ }
    }
    const appError = normalizeError(error);
    appError.operationId = payload.plan.operationId;
    throw appError;
  } finally {
    if (db) db.close();
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

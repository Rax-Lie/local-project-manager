'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, ROOT_INIT_MARKER } = require('../shared/constants');
const { fileUriToPath, normalizeFileUri } = require('../shared/paths');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const { readRootBootstrap, inspectRootBootstrapArtifacts } = require('./root-bootstrap');
const { applyRootBootstrap } = require('./root-bootstrap-apply');

/**
 * 处理尚无可用 pm.json/SQLite 上下文的根初始化恢复；没有外部标记时交回常规恢复流程。
 * @param {{rootUri: string, rootId?: string, operationId?: string, apply: boolean}} payload
 * @returns {Promise<object|null>}
 */
async function recoverRootBootstrap(payload) {
  const rootUri = normalizeFileUri(payload.rootUri);
  const fsPort = new SafeFileSystem(fileUriToPath(rootUri));
  const marker = await fsPort.inspect(ROOT_INIT_MARKER);
  if (!marker.exists) return null;

  let record;
  try {
    record = await readRootBootstrap(fsPort, rootUri);
    if (payload.operationId && payload.operationId !== record.operationId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '找不到指定的初始化操作。');
    }
    if (payload.rootId && payload.rootId !== record.rootId) {
      throw new AppError(ERROR_CODES.CONFLICT, 'rootId 与初始化恢复标记不匹配。');
    }
  } catch (error) {
    return bootstrapReport({
      rootUri,
      apply: payload.apply,
      operation: {
        operationId: null,
        state: 'needs_recovery',
        checks: [{ name: 'bootstrap_marker', ok: false, message: error.message }],
        action: 'manual',
        recovered: false,
        message: '初始化标记无法验证；未修改文件，请人工检查。'
      }
    });
  }

  const checks = await inspectRootBootstrapArtifacts(fsPort, record);
  const operation = {
    operationId: record.operationId,
    kind: 'root.initialize',
    state: checks.every((item) => item.ok) ? 'applying' : 'needs_recovery',
    projectId: null,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    checks,
    action: checks.every((item) => item.ok) ? 'resume' : 'manual',
    recovered: false,
    message: checks.every((item) => item.ok)
      ? '已有内容与初始化标记一致，可安全补建缺失项。'
      : '初始化内容发生冲突，已停止自动恢复且不会覆盖现有文件。'
  };
  if (payload.apply && operation.action === 'resume') {
    try {
      await applyRootBootstrap(record);
      operation.state = 'completed';
      operation.action = 'none';
      operation.recovered = true;
      operation.message = '根初始化已安全恢复并完成。';
    } catch (error) {
      operation.state = 'needs_recovery';
      operation.action = 'manual';
      operation.checks.push({ name: 'resume', ok: false, message: error.message });
      operation.message = '恢复过程中检测到冲突或错误；恢复标记保留，请人工检查。';
    }
  }
  return bootstrapReport({
    rootUri,
    apply: payload.apply,
    rootInitialized: operation.state === 'completed',
    operation
  });
}

/**
 * @param {{rootUri: string, apply: boolean, rootInitialized?: boolean, operation: object}} value
 */
function bootstrapReport(value) {
  const { operation } = value;
  return {
    rootUri: value.rootUri,
    rootInitialized: value.rootInitialized === true,
    apply: value.apply,
    operations: [operation],
    issues: operation.action === 'manual' ? [{
      code: 'ROOT_INITIALIZATION_RECOVERY_REQUIRED',
      severity: 'error',
      message: operation.message
    }] : [],
    summary: {
      incomplete: operation.state === 'completed' ? 0 : 1,
      needsRecovery: operation.state === 'needs_recovery' ? 1 : 0,
      recovered: operation.recovered ? 1 : 0
    }
  };
}

module.exports = {
  recoverRootBootstrap
};

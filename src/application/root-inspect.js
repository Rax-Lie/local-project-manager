'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, PM_DIR } = require('../shared/constants');
const { fileUriToPath, normalizeFileUri } = require('../shared/paths');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const {
  CONFIG_RELATIVE_PATH,
  DB_RELATIVE_PATH,
  TEMPLATES_RELATIVE_DIR,
  readRootConfig,
  discoverTemplates,
  withRootContext
} = require('./context');
const { ROOT_INIT_MARKER, readRootBootstrap } = require('./root-bootstrap');

/**
 * 只读检查根目录，不创建任何文件。未初始化也返回结构化结果，供 UI 展示。
 * @param {{rootUri: string}} input
 * @returns {Promise<object>}
 */
async function inspectRoot(input) {
  if (!input || typeof input !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'root.inspect 需要 rootUri。');
  }
  const rootUri = normalizeFileUri(input.rootUri);
  const rootPath = fileUriToPath(rootUri);
  const fsPort = new SafeFileSystem(rootPath);
  const rootInfo = await fsPort.inspect('');
  const base = {
    rootUri,
    rootPath,
    displayName: null,
    exists: rootInfo.exists,
    isDirectory: rootInfo.type === 'directory',
    isSymlink: rootInfo.isSymlink,
    isEmpty: false,
    initialized: false,
    partial: false,
    config: null,
    issues: [],
    incompleteOperations: [],
    bootstrapOperationId: null,
    templateDiagnostics: [],
    database: { exists: false, quickCheck: 'unknown', schemaVersion: 0, sqliteVersion: 'unknown' }
  };
  if (!rootInfo.exists) {
    base.issues.push(issue('ROOT_NOT_FOUND', '根目录不存在。'));
    return base;
  }
  if (rootInfo.isSymlink) {
    base.issues.push(issue('ROOT_REPARSE_POINT', '根目录是符号链接或 junction，出于安全考虑拒绝使用。'));
    return base;
  }
  if (rootInfo.type !== 'directory') {
    base.issues.push(issue('ROOT_NOT_DIRECTORY', '所选路径不是目录。'));
    return base;
  }

  const entries = await fsPort.listDirectory('');
  base.isEmpty = entries.length === 0;

  const bootstrapInfo = await fsPort.inspect(ROOT_INIT_MARKER);
  if (bootstrapInfo.exists) {
    base.partial = true;
    try {
      const bootstrap = await readRootBootstrap(fsPort, rootUri);
      base.bootstrapOperationId = bootstrap.operationId;
      base.issues.push(issue(
        'ROOT_INITIALIZATION_INCOMPLETE',
        '根目录初始化尚未完成，可通过“检查未完成操作”安全恢复。',
        'warning'
      ));
    } catch (error) {
      base.issues.push(issue('ROOT_INITIALIZATION_MARKER_INVALID', error.message, 'error'));
    }
  }

  const pmInfo = await fsPort.inspect(PM_DIR);
  if (pmInfo.exists && (pmInfo.isSymlink || pmInfo.type !== 'directory')) {
    base.partial = true;
    base.issues.push(issue('PM_NOT_DIRECTORY', '.pm 已存在但不是普通目录。'));
    return base;
  }

  const configInfo = await fsPort.inspect(CONFIG_RELATIVE_PATH);
  if (!configInfo.exists) {
    base.partial = base.partial || pmInfo.exists;
    if (pmInfo.exists && !bootstrapInfo.exists) {
      base.issues.push(issue('CONFIG_MISSING', '.pm 已存在但缺少 pm.json，可能是中断的初始化。'));
    }
    return base;
  }

  try {
    base.config = await readRootConfig(fsPort);
    base.initialized = true;
    base.displayName = base.config.displayName;
  } catch (error) {
    base.partial = true;
    base.issues.push(issue('CONFIG_INVALID', error.message, 'error', error.details));
    return base;
  }

  for (const partition of base.config.partitions) {
    const info = await fsPort.inspect(partition.relativePath);
    if (!info.exists || info.type !== 'directory' || info.isSymlink) {
      base.partial = true;
      base.issues.push(issue(
        'PARTITION_MISSING',
        `分区目录缺失或不是普通目录：${partition.relativePath}`,
        'error'
      ));
    }
  }
  const templatesInfo = await fsPort.inspect(TEMPLATES_RELATIVE_DIR);
  if (!templatesInfo.exists || templatesInfo.type !== 'directory' || templatesInfo.isSymlink) {
    base.partial = true;
    base.issues.push(issue('TEMPLATES_MISSING', '模板目录缺失或不是普通目录。', 'error'));
  }

  const dbInfo = await fsPort.inspect(DB_RELATIVE_PATH);
  base.database.exists = dbInfo.exists;
  if (!dbInfo.exists) {
    base.partial = true;
    base.issues.push(issue('DATABASE_MISSING', '根配置存在但数据库缺失，需要恢复。'));
  } else if (dbInfo.isSymlink || dbInfo.type !== 'file') {
    base.partial = true;
    base.issues.push(issue('DATABASE_NOT_FILE', '数据库路径不是普通文件。'));
  } else {
    try {
      await withRootContext(rootUri, async (context) => {
        const check = context.db.quickCheck();
        base.database.quickCheck = check.ok ? 'ok' : check.messages.join('; ');
        base.database.schemaVersion = context.db.version;
        base.database.sqliteVersion = context.db.sqliteVersion();
        base.incompleteOperations = (await context.journal.listIncomplete(base.config.rootId))
          .map((operation) => ({
            operationId: operation.operationId,
            kind: operation.kind,
            state: operation.state,
            projectId: operation.projectId || null,
            updatedAt: operation.updatedAt
          }));
      });
    } catch (error) {
      base.partial = true;
      base.issues.push(issue('DATABASE_ERROR', `数据库检查失败：${error.message}`));
    }
  }

  try {
    const templates = await discoverTemplates(fsPort);
    base.templateDiagnostics = templates.diagnostics;
  } catch (error) {
    base.issues.push(issue('TEMPLATES_ERROR', error.message));
  }

  if (base.incompleteOperations.length > 0) {
    base.issues.push(issue(
      'OPERATIONS_INCOMPLETE',
      `存在 ${base.incompleteOperations.length} 个未完成操作，请运行“检查未完成操作”。`,
      'warning'
    ));
  }
  if (base.database.quickCheck !== 'ok' && base.database.exists) {
    base.issues.push(issue('DATABASE_CHECK_FAILED', '数据库完整性检查未通过。', 'error'));
  }
  return base;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {'info'|'warning'|'error'} [severity]
 * @param {unknown} [details]
 */
function issue(code, message, severity = 'info', details) {
  const diagnostic = { code, message, severity };
  if (details !== undefined) diagnostic.details = details;
  return diagnostic;
}

module.exports = {
  inspectRoot,
  issue
};

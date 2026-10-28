'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, ROOT_INIT_MARKER, PM_DIR, DB_FILE, TEMPLATES_DIR, BACKUPS_DIR } = require('../shared/constants');
const { isPlainObject, hashJson } = require('../shared/json');
const { normalizeFileUri, sameFileUri, validateWorkspaceFileUri } = require('../shared/paths');
const { validateRootConfig, serializeRootConfig } = require('../domain/root-config');
const { validateTemplate } = require('../domain/template');

const BOOTSTRAP_VERSION = 1;
const MAX_BOOTSTRAP_BYTES = 4 * 1024 * 1024;
const BOOTSTRAP_KEYS = [
  'version', 'operationId', 'rootId', 'rootUri', 'input', 'config', 'templateFiles',
  'changedPaths', 'createdAt', 'checksum'
];

/**
 * 将恢复所需的初始化意图保存在 SQLite 之外，确保数据库创建前也能恢复。
 * @param {{operationId: string, rootId: string, input: object, config: object, templateFiles: object[], changedPaths: string[]}} value
 */
function createRootBootstrap(value) {
  const record = {
    version: BOOTSTRAP_VERSION,
    operationId: value.operationId,
    rootId: value.rootId,
    rootUri: normalizeFileUri(value.input.rootUri),
    input: value.input,
    config: value.config,
    templateFiles: value.templateFiles,
    changedPaths: value.changedPaths,
    createdAt: new Date().toISOString()
  };
  return { ...record, checksum: hashJson(record) };
}

/**
 * @param {import('../adapters/filesystem/safe-fs').SafeFileSystem} fsPort
 * @param {object} record
 */
async function writeRootBootstrap(fsPort, record) {
  await fsPort.writeFileExclusive(ROOT_INIT_MARKER, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * @param {import('../adapters/filesystem/safe-fs').SafeFileSystem} fsPort
 * @param {string} expectedRootUri
 * @returns {Promise<object|null>}
 */
async function readRootBootstrap(fsPort, expectedRootUri) {
  const info = await fsPort.inspect(ROOT_INIT_MARKER);
  if (!info.exists) return null;
  if (info.type !== 'file' || info.isSymlink) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记不是普通文件，已停止自动恢复。');
  }
  const raw = await fsPort.readJson(ROOT_INIT_MARKER, MAX_BOOTSTRAP_BYTES);
  return validateRootBootstrap(raw, expectedRootUri);
}

/**
 * @param {unknown} raw
 * @param {string} expectedRootUri
 */
function validateRootBootstrap(raw, expectedRootUri) {
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => !BOOTSTRAP_KEYS.includes(key))) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记字段无效。');
  }
  if (BOOTSTRAP_KEYS.some((key) => !(key in raw)) || raw.version !== BOOTSTRAP_VERSION) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记版本或字段不完整。');
  }
  const { checksum, ...body } = raw;
  if (typeof checksum !== 'string' || hashJson(body) !== checksum) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记校验失败，未执行任何更改。');
  }
  const rootUri = normalizeFileUri(raw.rootUri);
  if (!sameFileUri(rootUri, normalizeFileUri(expectedRootUri))) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记指向其他管理根。');
  }
  if (!/^op_[A-Za-z0-9-]{6,128}$/.test(raw.operationId)
    || !/^root_[A-Za-z0-9-]{6,128}$/.test(raw.rootId)
    || !isPlainObject(raw.input) || !Array.isArray(raw.templateFiles)
    || !Array.isArray(raw.changedPaths) || raw.changedPaths.some((item) => typeof item !== 'string')) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记中的操作信息无效。');
  }
  const config = validateRootConfig(raw.config);
  const input = raw.input;
  if (!sameFileUri(normalizeFileUri(input.rootUri), rootUri)
    || !sameFileUri(validateWorkspaceFileUri(input.workspaceUri), config.workspaceUri)
    || raw.rootId !== config.rootId || input.displayName !== config.displayName
    || hashJson(input.partitions) !== hashJson(config.partitions)
    || hashJson(input.slugRules) !== hashJson(config.slugRules)) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记与根配置不一致。');
  }
  for (const entry of raw.templateFiles) {
    if (!isPlainObject(entry) || typeof entry.relativePath !== 'string' || typeof entry.content !== 'string') {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记中的模板定义无效。');
    }
    let template;
    try {
      template = JSON.parse(entry.content);
      validateTemplate(template);
    } catch (error) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, `初始化模板定义无效：${error.message}`);
    }
    if (entry.relativePath !== `${PM_DIR}/${TEMPLATES_DIR}/${template.id}.json`) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记包含越界的模板路径。');
    }
  }
  return { ...body, config, input, checksum };
}

/**
 * 检查已有副作用是否仍符合初始化意图；缺失项可补建，冲突项必须人工处理。
 * @param {import('../adapters/filesystem/safe-fs').SafeFileSystem} fsPort
 * @param {object} record
 * @returns {Promise<object[]>}
 */
async function inspectRootBootstrapArtifacts(fsPort, record) {
  const checks = [];
  const directories = [
    PM_DIR,
    `${PM_DIR}/${TEMPLATES_DIR}`,
    `${PM_DIR}/${BACKUPS_DIR}`,
    ...record.config.partitions.map((item) => item.relativePath)
  ];
  for (const relativePath of directories) {
    const info = await fsPort.inspect(relativePath);
    const ok = !info.exists || (info.type === 'directory' && !info.isSymlink);
    checks.push({
      name: `directory:${relativePath}`,
      ok,
      message: ok ? `${relativePath} 可安全创建或已是普通目录。` : `${relativePath} 已被非目录或链接占用。`
    });
  }
  const files = [
    { relativePath: `${PM_DIR}/pm.json`, content: serializeRootConfig(record.config) },
    ...record.templateFiles
  ];
  for (const file of files) checks.push(await inspectExpectedFile(fsPort, file.relativePath, file.content));
  const database = await fsPort.inspect(`${PM_DIR}/${DB_FILE}`);
  const databaseOk = !database.exists || (database.type === 'file' && !database.isSymlink);
  checks.push({
    name: 'database_file',
    ok: databaseOk,
    message: databaseOk ? '数据库可安全创建或已是普通文件。' : '数据库路径被非普通文件或链接占用。'
  });
  return checks;
}

/**
 * @param {import('../adapters/filesystem/safe-fs').SafeFileSystem} fsPort
 * @param {string} relativePath
 * @param {string} expected
 */
async function inspectExpectedFile(fsPort, relativePath, expected) {
  const info = await fsPort.inspect(relativePath);
  if (!info.exists) return { name: `file:${relativePath}`, ok: true, message: `${relativePath} 尚未创建。` };
  if (info.type !== 'file' || info.isSymlink) {
    return { name: `file:${relativePath}`, ok: false, message: `${relativePath} 被非普通文件或链接占用。` };
  }
  const matches = (await fsPort.readText(relativePath, MAX_BOOTSTRAP_BYTES)) === expected;
  return {
    name: `file:${relativePath}`,
    ok: matches,
    message: matches ? `${relativePath} 内容与初始化计划一致。` : `${relativePath} 内容已变化，恢复不会覆盖。`
  };
}

/**
 * 仅测试进程可启用的进程级崩溃注入点。
 * @param {string} point
 */
function crashAtBootstrapPoint(point) {
  if (process.env.PM_TEST_FAILPOINTS === '1' && process.env.PM_TEST_CRASH_AFTER === point) {
    process.exit(86);
  }
}

module.exports = {
  ROOT_INIT_MARKER,
  createRootBootstrap,
  writeRootBootstrap,
  readRootBootstrap,
  inspectRootBootstrapArtifacts,
  crashAtBootstrapPoint
};

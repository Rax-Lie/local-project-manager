'use strict';

const path = require('node:path');
const { AppError } = require('../shared/errors');
const { ERROR_CODES, PM_DIR, DB_FILE, TEMPLATES_DIR, BACKUPS_DIR } = require('../shared/constants');
const { hashJson } = require('../shared/json');
const { fileUriToPath } = require('../shared/paths');
const { createOperationRecord } = require('../domain/operation');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const { SqliteDatabase } = require('../adapters/sqlite/database');
const { OperationJournal } = require('../adapters/sqlite/operation-journal');
const { TemplateIndex } = require('../adapters/sqlite/template-index');
const { serializeRootConfig } = require('../domain/root-config');
const { discoverTemplates } = require('./context');
const {
  ROOT_INIT_MARKER,
  readRootBootstrap,
  inspectRootBootstrapArtifacts,
  crashAtBootstrapPoint
} = require('./root-bootstrap');

/**
 * 按恢复标记幂等完成初始化；已有内容只有与原计划逐字一致时才会保留并继续。
 * @param {object} record
 */
async function applyRootBootstrap(record) {
  const rootPath = fileUriToPath(record.rootUri);
  const fsPort = new SafeFileSystem(rootPath);
  const checks = await inspectRootBootstrapArtifacts(fsPort, record);
  if (checks.some((item) => !item.ok)) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化路径已发生冲突，未覆盖现有内容。', {
      details: { checks }
    });
  }

  const db = new SqliteDatabase(path.join(rootPath, PM_DIR, DB_FILE));
  let journal;
  let operationStarted = false;
  try {
    await ensureDirectory(fsPort, PM_DIR);
    crashAtBootstrapPoint('pm_directory');
    await db.open();
    crashAtBootstrapPoint('database_open');
    journal = new OperationJournal(db);
    const operationRecord = createOperationRecord({
      operationId: record.operationId,
      rootId: record.rootId,
      kind: 'root.initialize',
      state: 'applying',
      payload: { bootstrapVersion: record.version, bootstrapChecksum: record.checksum },
      completedSteps: []
    });
    await assertBootstrapDatabase(db, journal, record);
    let operation = await journal.begin(operationRecord);
    if (operation.rootId !== record.rootId
      || operation.payload?.bootstrapChecksum !== record.checksum) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '数据库中的初始化日志与恢复标记不一致。');
    }
    if (operation.state === 'needs_recovery') {
      operation = await journal.transition(record.operationId, 'needs_recovery', 'applying');
    }
    if (!['applying', 'completed'].includes(operation.state)) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, `初始化日志处于不可恢复状态：${operation.state}`);
    }
    operationStarted = true;
    crashAtBootstrapPoint('journal_begin');

    await ensureDirectory(fsPort, `${PM_DIR}/${TEMPLATES_DIR}`);
    crashAtBootstrapPoint('templates_directory');
    await ensureDirectory(fsPort, `${PM_DIR}/${BACKUPS_DIR}`);
    crashAtBootstrapPoint('backups_directory');
    for (const partition of record.config.partitions) {
      await ensureDirectoryTree(fsPort, partition.relativePath);
      crashAtBootstrapPoint(`partition_${partition.id}`);
    }

    await writeExpectedFile(fsPort, `${PM_DIR}/pm.json`, serializeRootConfig(record.config));
    crashAtBootstrapPoint('config_write');
    for (const entry of record.templateFiles) {
      await writeExpectedFile(fsPort, entry.relativePath, entry.content);
      const template = JSON.parse(entry.content);
      crashAtBootstrapPoint(`template_${template.id}`);
    }
    const discovered = await discoverTemplates(fsPort);
    if (discovered.diagnostics.some((item) => item.severity === 'error')) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '内置模板写入后校验失败。');
    }
    const expectedTemplatePaths = new Set(record.templateFiles.map((item) => item.relativePath));
    if (discovered.entries.length !== expectedTemplatePaths.size
      || discovered.entries.some((item) => !expectedTemplatePaths.has(item.relativePath))) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '模板目录出现初始化标记之外的模板，未自动纳入索引。');
    }
    await new TemplateIndex(db).sync(record.rootId, discovered.entries);
    crashAtBootstrapPoint('template_index');
    const integrity = db.quickCheck();
    if (!integrity.ok) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `数据库完整性检查失败：${integrity.messages.join('; ')}`);
    }
    crashAtBootstrapPoint('integrity_check');

    operation = await journal.get(record.operationId);
    if (operation?.state === 'applying') {
      await journal.transition(record.operationId, 'applying', 'completed', {
        completedSteps: [
          'bootstrap_marker', 'pm_directory', 'database', 'partitions', 'config',
          'templates', 'template_index', 'integrity_check'
        ]
      });
    }
    crashAtBootstrapPoint('journal_complete');
    await removeMatchingBootstrap(fsPort, record);
    crashAtBootstrapPoint('marker_removed');
    return {
      operationId: record.operationId,
      state: 'completed',
      changedPaths: record.changedPaths,
      requiresWorkspaceSync: false,
      warnings: [],
      config: record.config
    };
  } catch (error) {
    if (operationStarted && journal) {
      try {
        const latest = await journal.get(record.operationId);
        if (latest?.state === 'applying') {
          await journal.markNeedsRecovery(record.operationId, 'applying', error.message);
        }
      } catch { /* 保留原错误；恢复标记仍是外部持久化依据 */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * @param {SqliteDatabase} db
 * @param {OperationJournal} journal
 * @param {object} record
 */
async function assertBootstrapDatabase(db, journal, record) {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name);
  if (tables.some((name) => !['templates', 'projects', 'operations'].includes(name))) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '数据库包含初始化计划之外的数据表，已停止自动恢复。');
  }
  const existing = await journal.get(record.operationId);
  if (existing) {
    if (existing.kind !== 'root.initialize' || existing.rootId !== record.rootId
      || existing.payload?.bootstrapChecksum !== record.checksum) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '数据库已存在不匹配的初始化记录。');
    }
    return;
  }
  const counts = ['templates', 'projects', 'operations'].map((table) => Number(
    db.get(`SELECT COUNT(*) AS count FROM ${table}`).count
  ));
  if (counts.some((count) => count !== 0)) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '数据库已有业务记录但缺少初始化日志，已停止自动恢复。');
  }
}

/**
 * @param {SafeFileSystem} fsPort
 * @param {string} relativePath
 */
async function ensureDirectory(fsPort, relativePath) {
  const info = await fsPort.inspect(relativePath);
  if (info.exists) {
    if (info.type !== 'directory' || info.isSymlink) {
      throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, `目录路径发生冲突：${relativePath}`);
    }
    return;
  }
  try {
    await fsPort.createDirectoryExclusive(relativePath);
  } catch (error) {
    const raced = await fsPort.inspect(relativePath);
    if (raced.exists && raced.type === 'directory' && !raced.isSymlink) return;
    throw error;
  }
}

/**
 * @param {SafeFileSystem} fsPort
 * @param {string} relativePath
 */
async function ensureDirectoryTree(fsPort, relativePath) {
  const segments = relativePath.split('/');
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    await ensureDirectory(fsPort, current);
  }
}

/**
 * @param {SafeFileSystem} fsPort
 * @param {string} relativePath
 * @param {string} content
 */
async function writeExpectedFile(fsPort, relativePath, content) {
  const info = await fsPort.inspect(relativePath);
  if (!info.exists) {
    try {
      await fsPort.writeFileExclusive(relativePath, content);
    } catch (error) {
      const raced = await fsPort.inspect(relativePath);
      if (!raced.exists) throw error;
    }
  }
  const latest = await fsPort.inspect(relativePath);
  if (latest.type !== 'file' || latest.isSymlink
    || (await fsPort.readText(relativePath)) !== content) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, `文件与初始化计划不一致，未覆盖：${relativePath}`);
  }
}

/**
 * @param {SafeFileSystem} fsPort
 * @param {object} record
 */
async function removeMatchingBootstrap(fsPort, record) {
  const latest = await readRootBootstrap(fsPort, record.rootUri);
  if (!latest || latest.checksum !== record.checksum || hashJson(latest) !== hashJson(record)) {
    throw new AppError(ERROR_CODES.RECOVERY_REQUIRED, '初始化恢复标记在操作期间发生变化，未删除。');
  }
  await fsPort.removeFile(ROOT_INIT_MARKER);
}

module.exports = {
  applyRootBootstrap
};

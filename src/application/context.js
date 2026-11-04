'use strict';

const path = require('node:path');
const { AppError, normalizeError } = require('../shared/errors');
const {
  ERROR_CODES,
  PM_DIR,
  CONFIG_FILE,
  DB_FILE,
  TEMPLATES_DIR,
  LIMITS
} = require('../shared/constants');
const { fileUriToPath, normalizeFileUri } = require('../shared/paths');
const { validateRootConfig } = require('../domain/root-config');
const { validateTemplate } = require('../domain/template');
const { SafeFileSystem } = require('../adapters/filesystem/safe-fs');
const { SqliteDatabase } = require('../adapters/sqlite/database');
const { ProjectRepository } = require('../adapters/sqlite/project-repository');
const { OperationJournal } = require('../adapters/sqlite/operation-journal');
const { TemplateIndex } = require('../adapters/sqlite/template-index');
const { StagingIndex } = require('../adapters/sqlite/staging-index');

const CONFIG_RELATIVE_PATH = `${PM_DIR}/${CONFIG_FILE}`;
const DB_RELATIVE_PATH = `${PM_DIR}/${DB_FILE}`;
const TEMPLATES_RELATIVE_DIR = `${PM_DIR}/${TEMPLATES_DIR}`;

/**
 * @param {string} rootUri
 * @returns {{rootUri: string, rootPath: string, fs: SafeFileSystem}}
 */
function createRootBinding(rootUri) {
  const normalized = normalizeFileUri(rootUri);
  const rootPath = fileUriToPath(normalized);
  return { rootUri: normalized, rootPath, fs: new SafeFileSystem(rootPath) };
}

/**
 * @param {SafeFileSystem} fsPort
 * @returns {Promise<object>}
 */
async function readRootConfig(fsPort) {
  const info = await fsPort.inspect(CONFIG_RELATIVE_PATH);
  if (!info.exists) {
    throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, '管理根尚未初始化（缺少 .pm/pm.json）。');
  }
  const raw = await fsPort.readJson(CONFIG_RELATIVE_PATH, LIMITS.maxTemplateJsonBytes);
  try {
    return validateRootConfig(raw);
  } catch (error) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `根配置无效：${error.message}`,
      { details: error.details }
    );
  }
}

/**
 * @param {SafeFileSystem} fsPort
 * @returns {Promise<{entries: Array<{template: object, relativePath: string, fileName: string}>, diagnostics: Array<object>}>}
 */
async function discoverTemplates(fsPort) {
  let listing;
  try {
    listing = await fsPort.listDirectory(TEMPLATES_RELATIVE_DIR);
  } catch (error) {
    if (error.code === ERROR_CODES.CONFLICT) {
      throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, '模板目录缺失，管理根可能未初始化完整。');
    }
    throw error;
  }
  const files = listing
    .filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries = [];
  const diagnostics = [];
  const seenIds = new Map();
  for (const file of files) {
    const relativePath = `${TEMPLATES_RELATIVE_DIR}/${file.name}`;
    let template;
    try {
      const raw = await fsPort.readJson(relativePath, LIMITS.maxTemplateJsonBytes);
      validateTemplate(raw);
      template = raw;
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'TEMPLATE_INVALID',
        message: `${file.name}：${error.message}`,
        file: relativePath,
        details: error.details
      });
      continue;
    }
    if (seenIds.has(template.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'TEMPLATE_DUPLICATE_ID',
        message: `模板 id ${template.id} 与 ${seenIds.get(template.id)} 重复，已忽略 ${file.name}。`,
        file: relativePath
      });
      continue;
    }
    seenIds.set(template.id, file.name);
    entries.push({ template, relativePath, fileName: file.name });
  }
  return { entries, diagnostics };
}

/**
 * @param {object} template
 * @param {string} [fileName]
 * @returns {string}
 */
function serializeTemplate(template, fileName = `${template.id}.json`) {
  validateTemplate(template);
  return {
    relativePath: `${TEMPLATES_RELATIVE_DIR}/${fileName}`,
    content: `${JSON.stringify(template, null, 2)}\n`
  };
}

/**
 * @param {Array<{template: object, relativePath: string}>} entries
 * @param {string} templateId
 * @returns {{template: object, relativePath: string}}
 */
function findTemplate(entries, templateId) {
  const found = entries.find((entry) => entry.template.id === templateId);
  if (!found) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `找不到模板：${templateId}`);
  }
  return found;
}

/**
 * @param {string} rootUri
 * @param {{createDbIfMissing?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function openRootContext(rootUri, options = {}) {
  const binding = createRootBinding(rootUri);
  const config = await readRootConfig(binding.fs);
  const dbInfo = await binding.fs.inspect(DB_RELATIVE_PATH);
  if (!dbInfo.exists && !options.createDbIfMissing) {
    throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, '管理根数据库缺失（.pm/pm.sqlite）。');
  }
  const db = new SqliteDatabase(path.join(binding.rootPath, PM_DIR, DB_FILE));
  try {
    await db.open();
    const center = {
      rootUri: binding.rootUri,
      rootPath: binding.rootPath,
      config,
      fs: binding.fs,
      db,
      repo: new ProjectRepository(db),
      journal: new OperationJournal(db),
      templateIndex: new TemplateIndex(db),
      stagingIndex: new StagingIndex(db),
      close() { db.close(); }
    };
    return center;
  } catch (error) {
    db.close();
    throw normalizeError(error);
  }
}

/**
 * @param {string} rootUri
 * @param {(context: object) => Promise<T>} callback
 * @returns {Promise<T>}
 * @template T
 */
async function withRootContext(rootUri, callback) {
  const context = await openRootContext(rootUri);
  try {
    return await callback(context);
  } finally {
    context.close();
  }
}

module.exports = {
  CONFIG_RELATIVE_PATH,
  DB_RELATIVE_PATH,
  TEMPLATES_RELATIVE_DIR,
  createRootBinding,
  readRootConfig,
  discoverTemplates,
  serializeTemplate,
  findTemplate,
  openRootContext,
  withRootContext
};

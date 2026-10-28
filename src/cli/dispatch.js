'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = require('../shared/constants');
const { loadSqlite } = require('../adapters/sqlite/database');
const { inspectRoot } = require('../application/root-inspect');
const { executeRootInitialization } = require('../application/root-service');
const { planRootInitialization } = require('../application/root-plan');
const {
  listTemplates,
  validateTemplateOperation
} = require('../application/template-service');
const {
  planProjectCreation
} = require('../application/project-plan');
const {
  executeProjectCreation
} = require('../application/project-service');
const {
  completeWorkspaceSync
} = require('../application/project-workspace-service');
const {
  searchProjects
} = require('../application/project-query-service');
const {
  planArchive,
  executeArchive
} = require('../application/archive-service');
const {
  planFileTemplate,
  executeFileTemplate
} = require('../application/file-template-service');
const { inspectRecovery } = require('../application/recovery-service');

const CLI_VERSION = require('../../package.json').version;

/**
 * @param {string} operation
 * @param {Record<string, unknown>} payload
 * @returns {Promise<unknown>}
 */
async function dispatch(operation, payload) {
  switch (operation) {
    case 'system.health':
      return systemHealth(payload);
    case 'root.inspect':
      return inspectRoot(payload);
    case 'root.initialize.plan':
      return planRootInitialization(payload);
    case 'root.initialize.execute':
      return executeRootInitialization(payload);
    case 'template.list':
      return listTemplates(payload);
    case 'template.validate':
      return validateTemplateOperation(payload);
    case 'project.create.plan':
      return planProjectCreation(payload);
    case 'project.create.execute':
      return executeProjectCreation(payload);
    case 'project.workspace.complete':
      return completeWorkspaceSync(payload);
    case 'project.search':
      return searchProjects(payload);
    case 'project.archive.plan':
      return planArchive(payload);
    case 'project.archive.execute':
      return executeArchive(payload);
    case 'project.file.plan':
      return planFileTemplate(payload);
    case 'project.file.execute':
      return executeFileTemplate(payload);
    case 'operation.recover':
      return inspectRecovery(payload);
    default:
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `未知操作：${operation}`);
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {object}
 */
function systemHealth(payload) {
  for (const key of Object.keys(payload)) {
    if (key !== 'supportedProtocolVersions') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `system.health 包含未知字段：${key}`);
    }
  }
  if (payload.supportedProtocolVersions !== undefined && !Array.isArray(payload.supportedProtocolVersions)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'supportedProtocolVersions 必须是数组。');
  }
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    cliVersion: CLI_VERSION,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || null,
    platform: process.platform,
    arch: process.arch,
    sqlite: {
      available: false,
      version: null,
      error: null
    }
  };
  try {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(':memory:');
    try {
      result.sqlite.version = String(db.prepare('SELECT sqlite_version() AS version').get().version);
    } finally {
      db.close();
    }
    result.sqlite.available = true;
  } catch (error) {
    result.sqlite.error = error.message;
  }
  return result;
}

module.exports = {
  dispatch,
  systemHealth,
  CLI_VERSION
};

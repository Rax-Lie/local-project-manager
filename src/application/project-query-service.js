'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { normalizeFileUri } = require('../shared/paths');
const { projectSummary } = require('../domain/project');
const { withRootContext } = require('./context');
const { assertRootId } = require('./template-service');

/**
 * @param {{rootUri: string, rootId?: string, text?: string, status?: string, fieldFilters?: object[], cursor?: string, limit?: number}} payload
 * @returns {Promise<object>}
 */
async function searchProjects(payload) {
  assertObject(payload, 'project.search');
  assertOnlyKeys(payload, ['rootUri', 'rootId', 'text', 'status', 'fieldFilters', 'cursor', 'limit'], 'project.search');
  const rootUri = normalizeFileUri(payload.rootUri);
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    return context.repo.search({
      rootId: context.config.rootId,
      text: payload.text,
      status: payload.status,
      fieldFilters: payload.fieldFilters,
      cursor: payload.cursor,
      limit: payload.limit
    });
  });
}

/**
 * @param {{rootUri: string, rootId?: string, projectId: string}} payload
 * @returns {Promise<object>}
 */
async function getProject(payload) {
  assertObject(payload, 'project.get');
  assertOnlyKeys(payload, ['rootUri', 'rootId', 'projectId'], 'project.get');
  const rootUri = normalizeFileUri(payload.rootUri);
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    const project = await context.repo.getById(payload.projectId);
    if (!project) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目不存在：${payload.projectId}`);
    return projectSummary(project);
  });
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
  searchProjects,
  getProject
};

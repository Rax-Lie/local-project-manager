'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runCli } = require('./cli');

/**
 * @returns {Promise<string>}
 */
async function makeTempDir(prefix = 'pm-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} dir
 * @param {string} [name]
 * @returns {Promise<string>}
 */
async function makeWorkspaceFile(dir, name = 'test.code-workspace') {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `${JSON.stringify({ folders: [], settings: {} }, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function fileUri(filePath) {
  return pathToFileURL(filePath).href;
}

/**
 * @param {string} rootDir
 * @param {string} workspaceFile
 * @param {{displayName?: string, requestId?: string}} [options]
 * @returns {Promise<object>}
 */
async function planRootInit(rootDir, workspaceFile, options = {}) {
  const response = await runCli({
    protocolVersion: 1,
    requestId: options.requestId || 'req-root-plan',
    operation: 'root.initialize.plan',
    payload: {
      rootUri: fileUri(rootDir),
      workspaceUri: fileUri(workspaceFile),
      displayName: options.displayName || '测试管理根'
    }
  });
  if (!response.json?.ok) {
    throw new Error(`root.initialize.plan failed: ${JSON.stringify(response.json || response.stdout)}`);
  }
  return { plan: response.json.data, response };
}

/**
 * @param {string} rootDir
 * @param {string} workspaceFile
 * @param {{displayName?: string, requestId?: string}} [options]
 * @returns {Promise<object>}
 */
async function initRoot(rootDir, workspaceFile, options = {}) {
  const plan = options.plan || (await planRootInit(rootDir, workspaceFile, options)).plan;
  const response = await runCli({
    protocolVersion: 1,
    requestId: options.requestId || 'req-root-exec',
    operation: 'root.initialize.execute',
    payload: {
      input: {
        rootUri: fileUri(rootDir),
        workspaceUri: fileUri(workspaceFile),
        displayName: options.displayName || '测试管理根'
      },
      plan
    }
  });
  if (!response.json?.ok) {
    throw new Error(`root.initialize.execute failed: ${JSON.stringify(response.json || response.stdout)}`);
  }
  return { plan, result: response.json.data, response };
}

/**
 * @param {string} rootDir
 * @param {string} workspaceFile
 * @param {{displayName?: string, templateId?: string, fieldValues?: object, requestId?: string}} [options]
 */
async function createProject(rootDir, workspaceFile, options = {}) {
  const rootId = (await readRootConfig(rootDir)).rootId;
  const displayName = options.displayName || '示例项目';
  const templateId = options.templateId || 'standard';
  const planResponse = await runCli({
    protocolVersion: 1,
    requestId: options.requestId ? `${options.requestId}-plan` : 'req-create-plan',
    operation: 'project.create.plan',
    payload: {
      rootUri: fileUri(rootDir),
      rootId,
      templateId,
      expectedTemplateRevision: 1,
      displayName,
      fieldValues: options.fieldValues || { priority: '中' }
    }
  });
  if (!planResponse.json?.ok) {
    throw new Error(`project.create.plan failed: ${JSON.stringify(planResponse.json || planResponse.stdout)}`);
  }
  const plan = planResponse.json.data;
  const executeResponse = await runCli({
    protocolVersion: 1,
    requestId: options.requestId ? `${options.requestId}-exec` : 'req-create-exec',
    operation: 'project.create.execute',
    payload: {
      input: {
        rootUri: fileUri(rootDir),
        rootId,
        templateId,
        expectedTemplateRevision: 1,
        displayName,
        fieldValues: options.fieldValues || { priority: '中' }
      },
      plan
    }
  });
  if (!executeResponse.json?.ok) {
    throw new Error(`project.create.execute failed: ${JSON.stringify(executeResponse.json || executeResponse.stdout)}`);
  }
  return { plan, pending: executeResponse.json.data, rootId };
}

/**
 * @param {string} rootDir
 * @returns {Promise<object>}
 */
async function readRootConfig(rootDir) {
  return JSON.parse(await fs.readFile(path.join(rootDir, '.pm', 'pm.json'), 'utf8'));
}

/**
 * @param {object} pending
 * @param {string} rootDir
 * @param {string} workspaceFile
 * @returns {Promise<object>}
 */
async function completeWorkspace(pending, rootDir, workspaceFile) {
  const rootId = (await readRootConfig(rootDir)).rootId;
  const response = await runCli({
    protocolVersion: 1,
    requestId: 'req-workspace-complete',
    operation: 'project.workspace.complete',
    payload: {
      rootUri: fileUri(rootDir),
      rootId,
      operationId: pending.operationId,
      observedPresent: true,
      action: 'add',
      targetUri: pending.workspaceSync.targetUri
    }
  });
  if (!response.json?.ok) {
    throw new Error(`project.workspace.complete failed: ${JSON.stringify(response.json || response.stdout)}`);
  }
  return response.json.data;
}

/**
 * @param {string[]} paths
 */
async function removeAll(paths) {
  for (const target of paths) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = {
  makeTempDir,
  makeWorkspaceFile,
  fileUri,
  planRootInit,
  initRoot,
  createProject,
  readRootConfig,
  completeWorkspace,
  removeAll
};

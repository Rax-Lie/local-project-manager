'use strict';

const { normalizeError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { sameFileUri } = require('../../shared/paths');
const { STATUS_LABELS } = require('../tree-provider');

/**
 * @param {object} vscode
 * @param {object} outputChannel
 * @param {unknown} error
 * @param {{title?: string}} [options]
 */
async function showError(vscode, outputChannel, error, options = {}) {
  const appError = normalizeError(error);
  if (outputChannel?.appendLine) {
    outputChannel.appendLine(`[project-manager] ${appError.code}: ${appError.message}`);
    if (appError.stack) outputChannel.appendLine(appError.stack);
  }
  if (appError.code === ERROR_CODES.CANCELLED) {
    vscode.window.showInformationMessage('操作已取消。');
    return;
  }
  const prefix = options.title ? `${options.title}：` : '';
  const actions = [];
  if (appError.code === ERROR_CODES.RUNTIME_UNAVAILABLE) actions.push('打开运行时设置');
  if (appError.code === ERROR_CODES.RECOVERY_REQUIRED) actions.push('检查未完成操作');
  if (appError.code === ERROR_CODES.ROOT_NOT_INITIALIZED) actions.push('初始化管理根');
  const detail = safeDetail(appError.details);
  let choice;
  if (appError.code === ERROR_CODES.CONFLICT || appError.code === ERROR_CODES.VALIDATION_FAILED) {
    choice = await vscode.window.showWarningMessage(`${prefix}${appError.message}`, { modal: false, detail }, ...actions);
  } else {
    choice = await vscode.window.showErrorMessage(`${prefix}${appError.message}`, { modal: false, detail }, ...actions);
  }
  if (choice === '打开运行时设置') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'projectManager.nodePath');
  } else if (choice === '检查未完成操作') {
    await vscode.commands.executeCommand('projectManager.recoverOperations');
  } else if (choice === '初始化管理根') {
    await vscode.commands.executeCommand('projectManager.initializeRoot');
  }
}

/**
 * @param {unknown} details
 * @returns {string|undefined}
 */
function safeDetail(details) {
  if (details === undefined) return undefined;
  try {
    return JSON.stringify(details, null, 2).slice(0, 4000);
  } catch {
    return String(details).slice(0, 4000);
  }
}

/**
 * @param {object} plan
 * @returns {string}
 */
function planDetail(plan) {
  const lines = [];
  if (plan.summary?.title) lines.push(plan.summary.title);
  lines.push('');
  for (const line of plan.summary?.lines || []) lines.push(line);
  const warnings = plan.summary?.warnings || [];
  if (warnings.length > 0) {
    lines.push('', '注意：');
    for (const warning of warnings) lines.push(`- ${warning.message}`);
  }
  return lines.join('\n');
}

/**
 * @param {object} vscode
 * @param {object} plan
 * @param {{confirmLabel?: string, title?: string}} [options]
 * @returns {Promise<boolean>}
 */
async function confirmPlan(vscode, plan, options = {}) {
  const blocking = (plan.summary?.warnings || []).some((warning) => warning.severity === 'error');
  const detail = planDetail(plan);
  if (blocking) {
    await vscode.window.showErrorMessage(options.title || '计划存在阻塞问题，未执行。', { modal: true, detail });
    return false;
  }
  const label = options.confirmLabel || '确认执行';
  const choice = await vscode.window.showWarningMessage(
    options.title || '确认执行以下计划？',
    { modal: true, detail },
    label
  );
  return choice === label;
}

/**
 * @param {object} vscode
 * @param {string} title
 * @param {(token: object) => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
async function withProgress(vscode, title, task) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: true
  }, (progress, token) => task(token));
}

/**
 * @param {object} vscode
 * @param {object} provider
 * @param {string} [placeHolder]
 * @param {{includeErrors?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
async function pickRoot(vscode, provider, placeHolder = '选择管理根', options = {}) {
  const usable = provider.roots.filter((root) => root.inspection?.initialized
    && (options.includeErrors || !root.error));
  if (usable.length === 0) {
    await vscode.window.showWarningMessage('尚无可用管理根，请先运行“初始化管理根”。');
    return null;
  }
  if (usable.length === 1) return usable[0];
  const picked = await vscode.window.showQuickPick(
    usable.map((root) => ({
      label: root.inspection.config.displayName,
      description: root.inspection.rootPath,
      detail: `${root.projects.length} 个项目`,
      root
    })),
    { placeHolder, matchOnDescription: true }
  );
  return picked ? picked.root : null;
}

/**
 * @param {object} vscode
 * @param {object} root
 * @param {{includeArchived?: boolean, placeHolder?: string}} [options]
 * @returns {Promise<object>}
 */
async function pickProject(vscode, root, options = {}) {
  const projects = root.projects.filter((project) => options.includeArchived || project.status !== 'archived');
  if (projects.length === 0) {
    await vscode.window.showWarningMessage('该管理根下没有可选项目。');
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.displayName,
      description: `${STATUS_LABELS[project.status] || project.status} · ${project.slug}`,
      detail: project.relativePath,
      project
    })),
    { placeHolder: options.placeHolder || '选择项目', matchOnDescription: true, matchOnDetail: true }
  );
  return picked ? picked.project : null;
}

/**
 * @param {object} vscode
 * @param {string} workspaceUri
 * @returns {boolean}
 */
function isCurrentWorkspace(vscode, workspaceUri) {
  const file = vscode.workspace.workspaceFile;
  return Boolean(file && sameFileUri(file.toString(), workspaceUri));
}

/**
 * @param {object} vscode
 * @param {string} message
 * @param {string[]} [actions]
 * @returns {Promise<string|undefined>}
 */
async function showInfo(vscode, message, actions = []) {
  return vscode.window.showInformationMessage(message, ...actions);
}

module.exports = {
  showError,
  confirmPlan,
  planDetail,
  withProgress,
  pickRoot,
  pickProject,
  isCurrentWorkspace,
  showInfo
};

'use strict';

const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { confirmPlan, pickProject, pickRoot, withProgress } = require('./feedback');
const { assertWorkspace } = require('./project-flow');

/**
 * @param {{vscode: object, cli: object, provider: object, workspaceAdapter: object}} deps
 * @param {object} [item]
 */
async function archiveProjectFlow(deps, item) {
  const { vscode, cli, provider, workspaceAdapter } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  let root;
  let project;
  if (item?.kind === 'project' && item.root?.inspection) {
    root = item.root;
    project = item.project;
  } else {
    root = await pickRoot(vscode, provider, '选择项目所在的管理根');
    if (!root) return;
    project = await pickProject(vscode, root, { placeHolder: '选择要归档的项目' });
    if (!project) return;
  }
  assertWorkspace(vscode, root);
  if (project.status !== 'active') {
    throw new AppError(ERROR_CODES.CONFLICT, '只有活动项目可以归档。');
  }
  const rootUri = root.rootUri;
  const rootId = root.inspection.config?.rootId;
  const input = { rootUri, rootId, projectId: project.projectId, targetPartitionId: 'archive' };
  const plan = await cli.request('project.archive.plan', input);
  if (!(await confirmPlan(vscode, plan, {
    title: '确认归档？归档会移动目录并修改工作区。',
    confirmLabel: '确认归档'
  }))) return;
  const result = await withProgress(vscode, '正在归档项目…', (token) => cli.request(
    'project.archive.execute',
    { input, plan },
    { token }
  ));
  let syncError = null;
  if (result.requiresWorkspaceSync && result.workspaceSync) {
    try {
      const removed = await workspaceAdapter.removeFolder(
        result.workspaceSync.targetUri,
        root.inspection.config.workspaceUri
      );
      await cli.request('project.workspace.complete', {
        rootUri,
        rootId,
        operationId: result.operationId,
        observedPresent: removed.observedPresent,
        action: 'remove',
        targetUri: result.workspaceSync.targetUri
      });
    } catch (error) {
      syncError = error;
    }
  }
  await provider.refresh();
  if (syncError) {
    await vscode.window.showWarningMessage(
      `项目目录已移动到归档区，但工作区移除失败：${syncError.message}`,
      { detail: '项目处于“归档中”。修复工作区后运行“完成待同步项目”。' }
    );
  } else {
    vscode.window.showInformationMessage(`项目“${project.displayName}”已归档，可从归档目录访问。`);
  }
}

/**
 * @param {{vscode: object, cli: object, provider: object}} deps
 */
async function recoverOperationsFlow(deps) {
  const { vscode, cli, provider } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择要检查的管理根', { includeErrors: true });
  if (!root) return;
  const rootUri = root.rootUri;
  const rootId = root.inspection.config.rootId;
  const inspection = await cli.request('operation.recover', { rootUri, rootId, apply: false });
  if (!inspection.operations || inspection.operations.length === 0) {
    const errors = (inspection.issues || []).filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      await vscode.window.showWarningMessage(
        '没有未完成操作，但管理根存在问题，需要人工处理。',
        { modal: false, detail: errors.map((issue) => `- ${issue.message}`).join('\n') }
      );
    } else {
      vscode.window.showInformationMessage('没有未完成操作。');
    }
    return;
  }
  const detail = inspection.operations.map((operation) => [
    `${operation.kind} (${operation.operationId})`,
    `状态：${operation.state}`,
    ...operation.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.message}`),
    `建议：${operation.message}`
  ].join('\n')).join('\n\n');
  const choice = await vscode.window.showWarningMessage(
    `发现 ${inspection.operations.length} 个未完成操作。`,
    { modal: true, detail },
    '执行安全恢复'
  );
  if (choice !== '执行安全恢复') return;
  const applied = await cli.request('operation.recover', { rootUri, rootId, apply: true });
  await provider.refresh();
  const recovered = applied.operations.filter((operation) => operation.recovered).length;
  const manual = applied.operations.filter((operation) => operation.action === 'manual').length;
  const pending = applied.operations.filter((operation) => operation.action === 'workspace_sync').length;
  vscode.window.showInformationMessage(
    `安全恢复完成：已推进 ${recovered} 项；${pending} 项等待工作区同步；${manual} 项需人工检查。`
  );
  if (pending > 0) {
    await vscode.commands.executeCommand('projectManager.syncPending');
  }
}

module.exports = {
  archiveProjectFlow,
  recoverOperationsFlow
};

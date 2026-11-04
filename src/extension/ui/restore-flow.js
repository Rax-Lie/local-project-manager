'use strict';

const path = require('node:path');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { confirmPlan, pickProject, pickRoot, withProgress } = require('./feedback');
const { assertWorkspace } = require('./project-flow');

async function restoreProjectFlow(deps, item) {
  const { vscode, cli, provider, workspaceAdapter } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  let root = item?.kind === 'project' ? item.root : null;
  let project = item?.kind === 'project' ? item.project : null;
  if (!root) {
    root = await pickRoot(vscode, provider, '选择要恢复项目的管理根');
    if (!root) return;
    project = await pickProject(vscode, root, { includeArchived: true, placeHolder: '选择要恢复的归档项目' });
    if (!project) return;
  }
  if (project.status !== 'archived') throw new AppError(ERROR_CODES.CONFLICT, '只有已归档项目可以恢复。');
  assertWorkspace(vscode, root);
  const input = { rootUri: root.rootUri, rootId: root.inspection.config.rootId, projectId: project.projectId };
  const plan = await cli.request('project.restore.plan', input);
  if (!(await confirmPlan(vscode, plan, { title: '确认恢复项目并重新加入当前工作区？', confirmLabel: '确认恢复' }))) return;
  const result = await withProgress(vscode, '正在恢复项目…', (token) => cli.request(
    'project.restore.execute', { input, plan }, { token }
  ));
  let syncError = null;
  try {
    const added = await workspaceAdapter.addFolder(
      result.workspaceSync.targetUri, result.workspaceSync.displayName, root.inspection.config.workspaceUri
    );
    await cli.request('project.workspace.complete', {
      rootUri: root.rootUri, rootId: input.rootId, operationId: result.operationId,
      observedPresent: added.observedPresent, action: 'add', targetUri: result.workspaceSync.targetUri
    });
  } catch (error) {
    syncError = error;
  }
  await provider.refresh();
  if (syncError) {
    await vscode.window.showWarningMessage(
      `项目目录已恢复，但加入工作区失败：${syncError.message}`,
      { detail: '项目仍处于已归档状态。修复工作区后运行“完成待同步项目”。' }
    );
  } else {
    const absolute = path.join(root.inspection.rootPath, ...result.project.relativePath.split('/'));
    const choice = await vscode.window.showInformationMessage(`项目“${project.displayName}”已恢复。`, '在资源管理器中显示');
    if (choice === '在资源管理器中显示') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolute));
    }
  }
}

module.exports = { restoreProjectFlow };

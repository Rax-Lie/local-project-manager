'use strict';

const vscode = require('vscode');
const { CliClient } = require('./cli-client');
const { RootRegistry } = require('./root-registry');
const { WorkspaceAdapter } = require('./workspace-adapter');
const { ProjectTreeProvider } = require('./tree-provider');
const { showError } = require('./ui/feedback');
const { initializeRootFlow } = require('./ui/root-flow');
const {
  createProjectFlow,
  syncPendingFlow
} = require('./ui/project-flow');
const {
  archiveProjectFlow,
  recoverOperationsFlow
} = require('./ui/maintenance-flow');
const { applyFileTemplateFlow } = require('./ui/file-flow');
const { restoreProjectFlow } = require('./ui/restore-flow');
const { stagingSuggestionsFlow } = require('./staging/suggestions-flow');
const { searchProjectsFlow, copyProjectInfoFlow } = require('./ui/search-flow');
const { manageTemplatesFlow, saveTemplateDraftFlow } = require('./ui/template-flow');

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('通用项目管理');
  const getConfig = () => vscode.workspace.getConfiguration('projectManager');
  const cli = new CliClient({
    extensionPath: context.extensionPath,
    outputChannel,
    getConfig
  });
  const registry = new RootRegistry(context);
  const workspaceAdapter = new WorkspaceAdapter(vscode);
  const provider = new ProjectTreeProvider({ vscode, cli, registry, outputChannel });
  const treeView = vscode.window.createTreeView('projectManager.projects', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = '通用项目管理';
  statusBar.command = 'projectManager.searchProjects';
  statusBar.text = '$(folder-library) 项目管理';
  statusBar.tooltip = '搜索项目';
  statusBar.show();

  let refreshTimer = null;
  const updateStatus = () => {
    const count = provider.roots.reduce((total, root) => total + (root.projects?.length || 0), 0);
    statusBar.text = `$(folder-library) 项目 ${count}`;
    statusBar.tooltip = provider.roots.length === 0
      ? '尚未初始化管理根'
      : `${provider.roots.length} 个管理根，${count} 个项目`;
  };
  const refreshAll = async () => {
    await provider.refresh();
    updateStatus();
  };
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAll().catch((error) => showError(vscode, outputChannel, error));
    }, 500);
  };

  const register = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      await showError(vscode, outputChannel, error);
    } finally {
      updateStatus();
    }
  }));

  const flows = { vscode, cli, registry, provider, workspaceAdapter, outputChannel };
  register('projectManager.initializeRoot', () => initializeRootFlow(flows));
  register('projectManager.createProject', () => createProjectFlow(flows));
  register('projectManager.searchProjects', () => searchProjectsFlow(flows));
  register('projectManager.manageTemplates', () => manageTemplatesFlow(flows));
  register('projectManager.saveTemplateDraft', () => saveTemplateDraftFlow(flows));
  register('projectManager.applyFileTemplate', (item) => applyFileTemplateFlow(flows, item));
  register('projectManager.syncPending', () => syncPendingFlow(flows));
  register('projectManager.recoverOperations', () => recoverOperationsFlow(flows));
  register('projectManager.archiveProject', (item) => archiveProjectFlow(flows, item));
  register('projectManager.restoreProject', (item) => restoreProjectFlow(flows, item));
  register('projectManager.stagingSuggestions', () => stagingSuggestionsFlow(flows));
  register('projectManager.refresh', async () => {
    await provider.refresh();
    updateStatus();
  });
  register('projectManager.openProject', async (item) => {
    const absolute = provider.absolutePathOf(item);
    if (!absolute) {
      vscode.window.showWarningMessage('请在项目树中选择项目。');
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolute));
  });
  register('projectManager.copyProjectInfo', (item) => copyProjectInfoFlow(vscode, item));

  const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/.pm/**');
  context.subscriptions.push(workspaceWatcher);
  workspaceWatcher.onDidCreate(scheduleRefresh);
  workspaceWatcher.onDidChange(scheduleRefresh);
  workspaceWatcher.onDidDelete(scheduleRefresh);

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    await registry.discover(vscode).catch(() => {});
    scheduleRefresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('projectManager.nodePath')
      || event.affectsConfiguration('projectManager.requestTimeoutMs')) {
      cli.resetRuntime();
    }
    if (event.affectsConfiguration('projectManager')) scheduleRefresh();
  }));
  context.subscriptions.push(treeView.onDidChangeVisibility(() => {
    if (treeView.visible) scheduleRefresh();
  }));

  registry.discover(vscode)
    .catch((error) => showError(vscode, outputChannel, error))
    .then(() => refreshAll())
    .catch((error) => showError(vscode, outputChannel, error));

  context.subscriptions.push(outputChannel, statusBar, treeView, provider);
  context.subscriptions.push({ dispose() { if (refreshTimer) clearTimeout(refreshTimer); } });
}

function deactivate() {
  // 所有资源均已注册到 context.subscriptions。
}

module.exports = {
  activate,
  deactivate
};

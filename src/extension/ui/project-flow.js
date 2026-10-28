'use strict';

const path = require('node:path');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { fileUriToPath } = require('../../shared/paths');
const { confirmPlan, isCurrentWorkspace, pickRoot, withProgress } = require('./feedback');
const { askProjectFields, askProjectName } = require('./project-form');

/**
 * @param {{vscode: object, cli: object, provider: object, workspaceAdapter: object}} deps
 */
async function createProjectFlow(deps) {
  const { vscode, cli, provider, workspaceAdapter } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择要在其中新建项目的管理根');
  if (!root) return;
  assertWorkspace(vscode, root);
  const rootUri = root.rootUri;
  const rootId = root.inspection.config.rootId;

  const listed = await cli.request('template.list', { rootUri, rootId });
  const templates = (listed.templates || []).filter((template) => template.enabled !== false
    && Array.isArray(template.fields));
  if (templates.length === 0) {
    throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, '管理根没有可用模板，请检查 .pm/templates。');
  }
  const pickedTemplate = await vscode.window.showQuickPick(
    templates.map((template) => ({
      label: template.displayName,
      description: `${template.id} · r${template.revision} · ${template.fields.length} 个字段`,
      detail: `目录：${(template.directoryBlueprint || []).join('、') || '（无）'}`,
      template
    })),
    { placeHolder: '选择项目模板', matchOnDescription: true }
  );
  if (!pickedTemplate) return;
  const template = pickedTemplate.template;

  const displayName = await askProjectName(vscode);
  if (displayName === undefined) return;
  const fieldValues = await askProjectFields(vscode, template);
  if (fieldValues === undefined) return;

  const input = {
    rootUri,
    rootId,
    templateId: template.id,
    expectedTemplateRevision: template.revision,
    displayName,
    fieldValues
  };
  const plan = await cli.request('project.create.plan', input);
  if (!(await confirmPlan(vscode, plan, { title: '确认新建项目？' }))) return;
  const result = await withProgress(vscode, '正在创建项目…', (token) => cli.request(
    'project.create.execute',
    { input, plan },
    { token }
  ));

  const project = result.project || { displayName, relativePath: plan.details.relativePath };
  let syncError = null;
  let stillPending = false;
  if (result.requiresWorkspaceSync && result.workspaceSync) {
    try {
      const added = await workspaceAdapter.addFolder(
        result.workspaceSync.targetUri,
        result.workspaceSync.displayName,
        root.inspection.config.workspaceUri
      );
      const completed = await cli.request('project.workspace.complete', {
        rootUri,
        rootId,
        operationId: result.operationId,
        observedPresent: added.observedPresent,
        action: 'add',
        targetUri: result.workspaceSync.targetUri
      });
      stillPending = Boolean(completed.requiresWorkspaceSync);
    } catch (error) {
      syncError = error;
    }
  }
  await provider.refresh();

  if (syncError) {
    await vscode.window.showWarningMessage(
      `项目目录已创建，但加入工作区失败：${syncError.message}`,
      { modal: false, detail: '项目处于“待同步”状态。修复工作区后运行“完成待同步项目”，不会删除已创建内容。' }
    );
    return;
  }
  if (stillPending) {
    await vscode.window.showWarningMessage('项目目录已创建，但工作区尚未观察到新文件夹。请运行“完成待同步项目”。');
    return;
  }
  const absolute = project.relativePath && root.inspection
    ? path.join(root.inspection.rootPath, ...project.relativePath.split('/'))
    : null;
  const choice = await vscode.window.showInformationMessage(
    `项目“${project.displayName}”已创建并加入工作区。`,
    ...(absolute ? ['在资源管理器中显示', '应用 Markdown 模板'] : [])
  );
  if (choice === '在资源管理器中显示' && absolute) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolute));
  } else if (choice === '应用 Markdown 模板') {
    await vscode.commands.executeCommand('projectManager.applyFileTemplate');
  }
}

/**
 * @param {{vscode: object, cli: object, provider: object, workspaceAdapter: object}} deps
 */
async function syncPendingFlow(deps) {
  const { vscode, cli, provider, workspaceAdapter } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择要完成同步的管理根', { includeErrors: true });
  if (!root) return;
  assertWorkspace(vscode, root);
  const rootUri = root.rootUri;
  const rootId = root.inspection.config.rootId;
  const inspected = await cli.request('operation.recover', { rootUri, rootId, apply: false });
  if (!inspected.operations || inspected.operations.length === 0) {
    vscode.window.showInformationMessage('没有未完成操作。');
    return;
  }
  const detail = inspected.operations.map((operation) => (
    `- ${operation.kind} ${operation.operationId.slice(0, 16)}：${operation.state}；${operation.message}`
  )).join('\n');
  const choice = await vscode.window.showWarningMessage(
    `发现 ${inspected.operations.length} 个未完成操作，是否安全推进并同步？`,
    { modal: true, detail: `${detail}\n\n只会补记已确认完成的步骤，不会覆盖或删除用户内容。` },
    '安全推进并同步'
  );
  if (choice !== '安全推进并同步') return;

  const applied = await cli.request('operation.recover', { rootUri, rootId, apply: true });
  const failures = [];
  const notes = [];
  for (const operation of applied.operations || []) {
    if (operation.state === 'completed') continue;
    try {
      if (operation.kind === 'project.create'
        && operation.state === 'awaiting_workspace'
        && operation.project?.relativePath) {
        const targetPath = path.join(root.inspection.rootPath, ...operation.project.relativePath.split('/'));
        const targetUri = vscode.Uri.file(targetPath).toString();
        const added = await workspaceAdapter.addFolder(
          targetUri,
          operation.project.displayName,
          root.inspection.config.workspaceUri
        );
        await cli.request('project.workspace.complete', {
          rootUri,
          rootId,
          operationId: operation.operationId,
          observedPresent: added.observedPresent,
          action: 'add',
          targetUri
        });
        notes.push(`已同步项目：${operation.project.displayName}`);
      } else if (operation.kind === 'project.archive'
        && operation.state === 'awaiting_workspace'
        && operation.sourceRelativePath) {
        const oldPath = path.join(root.inspection.rootPath, ...operation.sourceRelativePath.split('/'));
        const oldUri = vscode.Uri.file(oldPath).toString();
        const removed = await workspaceAdapter.removeFolder(oldUri, root.inspection.config.workspaceUri);
        await cli.request('project.workspace.complete', {
          rootUri,
          rootId,
          operationId: operation.operationId,
          observedPresent: removed.observedPresent,
          action: 'remove',
          targetUri: oldUri
        });
        notes.push(`已移除归档项目文件夹：${operation.project?.displayName || operation.sourceRelativePath}`);
      } else if (operation.state === 'needs_recovery' || operation.action === 'manual') {
        failures.push(`${operation.operationId}：${operation.message || '需要人工恢复'}`);
      }
    } catch (error) {
      failures.push(`${operation.operationId}：${error.message}`);
    }
  }
  await provider.refresh();
  if (failures.length > 0) {
    await vscode.window.showWarningMessage(
      `完成 ${notes.length} 项，仍有 ${failures.length} 项需要处理。`,
      { modal: false, detail: failures.join('\n') }
    );
  } else {
    vscode.window.showInformationMessage(notes.length > 0 ? `已完成：${notes.join('；')}` : '没有需要同步的工作区变更。');
  }
}

/**
 * @param {object} vscode
 * @param {object} root
 */
function assertWorkspace(vscode, root) {
  if (!root?.inspection?.config) {
    throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, '管理根尚未初始化。');
  }
  if (!isCurrentWorkspace(vscode, root.inspection.config.workspaceUri)) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      `当前工作区不是该管理根绑定的目标工作区。请先打开：${fileUriToPath(root.inspection.config.workspaceUri)}`
    );
  }
}

module.exports = {
  createProjectFlow,
  syncPendingFlow,
  assertWorkspace
};

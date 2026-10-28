'use strict';

const path = require('node:path');
const { pickRoot } = require('./feedback');
const { STATUS_LABELS } = require('../tree-provider');

const STATUS_FILTERS = Object.freeze([
  { label: '全部状态', value: undefined },
  { label: '活动项目', value: 'active' },
  { label: '待同步', value: 'provisioning' },
  { label: '需要恢复', value: 'needs_recovery' },
  { label: '归档中', value: 'archiving' },
  { label: '已归档', value: 'archived' }
]);

/**
 * @param {{vscode: object, cli: object, provider: object, outputChannel: object}} deps
 */
async function searchProjectsFlow(deps) {
  const { vscode, cli, provider } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择要搜索的管理根');
  if (!root) return;
  const rootUri = root.rootUri;
  const rootId = root.inspection.config.rootId;

  const text = await vscode.window.showInputBox({
    title: '搜索项目',
    prompt: '按显示名称或 slug 搜索；留空表示不限制关键词。',
    placeHolder: '输入关键词'
  });
  if (text === undefined) return;
  const status = await vscode.window.showQuickPick(
    STATUS_FILTERS.map((item) => ({ label: item.label, value: item.value })),
    { placeHolder: '选择状态过滤' }
  );
  if (!status) return;
  const limit = Number(vscode.workspace.getConfiguration('projectManager').get('maxSearchResults')) || 100;
  const page = await cli.request('project.search', {
    rootUri,
    rootId,
    text: text.trim(),
    status: status.value,
    limit: Math.min(500, Math.max(1, limit))
  });
  if (!page.items || page.items.length === 0) {
    vscode.window.showInformationMessage('没有匹配的项目。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    page.items.map((project) => ({
      label: project.displayName,
      description: `${STATUS_LABELS[project.status] || project.status} · ${project.slug}`,
      detail: project.relativePath,
      project
    })),
    { placeHolder: `找到 ${page.items.length} 个项目`, matchOnDescription: true, matchOnDetail: true }
  );
  if (!picked) return;
  const project = picked.project;
  const absolute = path.join(root.inspection.rootPath, ...project.relativePath.split('/'));
  const fields = Object.entries(project.fieldValues || {})
    .map(([key, value]) => `${key}：${String(value ?? '')}`)
    .join('\n');
  const actions = ['在资源管理器中显示', '应用 Markdown 模板'];
  if (project.status === 'active') actions.push('归档项目');
  const choice = await vscode.window.showInformationMessage(
    project.displayName,
    {
      modal: true,
      detail: [
        `状态：${STATUS_LABELS[project.status] || project.status}`,
        `slug：${project.slug}`,
        `路径：${absolute}`,
        `创建时间：${project.createdAt}`,
        fields ? `\n字段：\n${fields}` : ''
      ].filter(Boolean).join('\n')
    },
    ...actions
  );
  const item = { kind: 'project', root, project };
  if (choice === '在资源管理器中显示') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolute));
  } else if (choice === '应用 Markdown 模板') {
    await vscode.commands.executeCommand('projectManager.applyFileTemplate', item);
  } else if (choice === '归档项目') {
    await vscode.commands.executeCommand('projectManager.archiveProject', item);
  }
}

/**
 * @param {object} vscode
 * @param {object} item
 * @returns {Promise<void>}
 */
async function copyProjectInfoFlow(vscode, item) {
  if (item?.kind !== 'project') {
    vscode.window.showWarningMessage('请在项目树或搜索结果中选择项目。');
    return;
  }
  const project = item.project;
  const absolute = item.root?.inspection
    ? path.join(item.root.inspection.rootPath, ...project.relativePath.split('/'))
    : project.relativePath;
  const fields = Object.entries(project.fieldValues || {})
    .map(([key, value]) => `${key}: ${String(value ?? '')}`)
    .join('\n');
  const text = [
    project.displayName,
    `slug: ${project.slug}`,
    `状态: ${project.status}`,
    `路径: ${absolute}`,
    `模板: ${project.templateId} (r${project.templateRevision})`,
    `创建: ${project.createdAt}`,
    fields ? `字段:\n${fields}` : ''
  ].filter(Boolean).join('\n');
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage('项目信息已复制到剪贴板', 3000);
}

module.exports = {
  searchProjectsFlow,
  copyProjectInfoFlow,
  STATUS_FILTERS
};

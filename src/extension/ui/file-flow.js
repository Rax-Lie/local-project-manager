'use strict';

const path = require('node:path');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { pickProject, pickRoot, withProgress } = require('./feedback');

/**
 * @param {{vscode: object, cli: object, provider: object}} deps
 * @param {object} [item]
 */
async function applyFileTemplateFlow(deps, item) {
  const { vscode, cli, provider } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  let root;
  let project;
  if (item?.kind === 'project' && item.root?.inspection) {
    root = item.root;
    project = item.project;
  } else {
    root = await pickRoot(vscode, provider, '选择项目所在的管理根');
    if (!root) return;
    project = await pickProject(vscode, root, { placeHolder: '选择要写入文件的项目' });
    if (!project) return;
  }
  if (project.status === 'archived' || project.status === 'archiving') {
    throw new AppError(ERROR_CODES.CONFLICT, '归档项目不能写入新文件。');
  }
  const rootUri = root.rootUri;
  const rootId = root.inspection.config.rootId;
  const listed = await cli.request('template.list', { rootUri, rootId });
  const options = [];
  for (const template of listed.templates || []) {
    for (const markdown of template.markdownTemplates || []) {
      options.push({
        label: `${template.displayName} / ${markdown.displayName || markdown.targetPath}`,
        description: markdown.targetPath,
        detail: `模板 ${template.id} · r${template.revision}`,
        template,
        markdown
      });
    }
  }
  if (options.length === 0) {
    vscode.window.showWarningMessage('当前模板没有可用的 Markdown 文件模板。');
    return;
  }
  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: '选择 Markdown 文件模板',
    matchOnDescription: true
  });
  if (!picked) return;

  const input = {
    rootUri,
    rootId,
    projectId: project.projectId,
    templateId: picked.template.id,
    expectedTemplateRevision: picked.template.revision,
    markdownId: picked.markdown.id
  };
  const plan = await cli.request('project.file.plan', input);
  if (plan.details?.blocking) {
    await vscode.window.showWarningMessage(
      `目标文件已存在，未写入：${plan.details.targetPath}`,
      { detail: '为避免覆盖用户内容，文件模板不会覆盖现有文件。' }
    );
    return;
  }
  const document = await vscode.workspace.openTextDocument({
    content: plan.details.content,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  const confirmed = await vscode.window.showWarningMessage(
    `确认写入 ${plan.details.targetPath}？`,
    {
      modal: true,
      detail: (plan.summary?.lines || []).join('\n')
    },
    '写入文件'
  );
  if (!confirmed) {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    return;
  }
  const result = await withProgress(vscode, '正在写入 Markdown 文件…', (token) => cli.request(
    'project.file.execute',
    { input, plan },
    { token }
  ));
  const absolute = path.join(root.inspection.rootPath, ...plan.details.targetPath.split('/'));
  await provider.refresh();
  const choice = await vscode.window.showInformationMessage(
    `已写入：${plan.details.targetPath}`,
    '打开文件'
  );
  if (choice === '打开文件') {
    const text = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    await vscode.window.showTextDocument(text, { preview: false });
  }
  return result;
}

module.exports = {
  applyFileTemplateFlow
};

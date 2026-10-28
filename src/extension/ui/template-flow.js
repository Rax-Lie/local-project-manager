'use strict';

const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { pickRoot } = require('./feedback');

const drafts = new WeakMap();

/** @param {{vscode: object, cli: object, provider: object}} deps */
async function manageTemplatesFlow(deps) {
  const { vscode, cli, provider } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择要管理模板的管理根');
  if (!root) return;
  const action = await vscode.window.showQuickPick([
    { label: '新建模板', action: 'create' },
    { label: '查看或编辑模板', action: 'edit' },
    { label: '启用或停用模板', action: 'toggle' },
    { label: '删除模板（停用并保留定义）', action: 'delete' }
  ], { placeHolder: '选择模板操作' });
  if (!action) return;
  if (action.action === 'create') return startTemplateDraft(vscode, root, await askNewTemplate(vscode));
  const templates = await getTemplates(cli, root);
  if (action.action === 'edit') {
    const template = await pickTemplate(vscode, templates, '选择要编辑的模板');
    if (template) await startTemplateDraft(vscode, root, nextRevisionTemplate(template));
    return;
  }
  const template = await pickTemplate(vscode, templates, '选择目标模板');
  if (!template) return;
  if (action.action === 'toggle') {
    const enabled = !template.enabled;
    await cli.request('template.setEnabled', {
      rootUri: root.rootUri,
      rootId: root.inspection.config.rootId,
      templateId: template.id,
      expectedRevision: template.revision,
      enabled
    });
    await provider.refresh();
    vscode.window.showInformationMessage(`模板“${template.displayName}”已${enabled ? '启用' : '停用'}。`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `删除模板“${template.displayName}”？`,
    { modal: true, detail: '删除会停用该模板并保留定义；已有项目不受影响，之后仍可重新启用。' },
    '删除模板'
  );
  if (choice !== '删除模板') return;
  await cli.request('template.delete', {
    rootUri: root.rootUri,
    rootId: root.inspection.config.rootId,
    templateId: template.id,
    expectedRevision: template.revision
  });
  await provider.refresh();
  vscode.window.showInformationMessage(`模板“${template.displayName}”已删除并停用。`);
}

/** @param {{vscode: object, cli: object, provider: object}} deps */
async function saveTemplateDraftFlow(deps) {
  const { vscode, cli, provider } = deps;
  const document = vscode.window.activeTextEditor?.document;
  const draft = document && drafts.get(document);
  if (!draft) {
    vscode.window.showWarningMessage('当前编辑器不是项目模板草稿。请从“管理项目模板”打开模板后再保存。');
    return;
  }
  let template;
  try {
    template = JSON.parse(document.getText());
  } catch (error) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `模板 JSON 无法解析：${error.message}`);
  }
  const validation = await cli.request('template.validate', { template });
  if (!validation.valid) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '模板校验失败。', {
      details: { errors: validation.errors }
    });
  }
  if (draft.mode === 'create') {
    await cli.request('template.create', {
      rootUri: draft.rootUri,
      rootId: draft.rootId,
      template
    });
  } else {
    await cli.request('template.update', {
      rootUri: draft.rootUri,
      rootId: draft.rootId,
      templateId: draft.templateId,
      expectedRevision: draft.expectedRevision,
      template
    });
  }
  drafts.delete(document);
  await provider.refresh();
  vscode.window.showInformationMessage(`模板“${template.displayName}”已保存。`);
}

async function askNewTemplate(vscode) {
  const id = await vscode.window.showInputBox({
    title: '新建项目模板',
    prompt: '输入稳定的模板 ID（小写字母、数字和连字符）',
    validateInput: (value) => /^[a-z][a-z0-9-]{1,63}$/.test(value || '') ? null : 'ID 必须匹配 ^[a-z][a-z0-9-]{1,63}$。'
  });
  if (id === undefined) return null;
  const displayName = await vscode.window.showInputBox({ title: '模板显示名称', prompt: '输入列表中显示的名称' });
  if (displayName === undefined) return null;
  return {
    id,
    revision: 1,
    displayName: displayName.trim(),
    fields: [],
    directoryBlueprint: ['docs'],
    markdownTemplates: []
  };
}

async function getTemplates(cli, root) {
  const result = await cli.request('template.list', {
    rootUri: root.rootUri,
    rootId: root.inspection.config.rootId
  });
  return result.templates || [];
}

async function pickTemplate(vscode, templates, placeHolder) {
  if (templates.length === 0) {
    vscode.window.showInformationMessage('该管理根还没有模板。');
    return null;
  }
  const picked = await vscode.window.showQuickPick(templates.map((template) => ({
    label: `${template.enabled ? '$(check) ' : '$(circle-slash) '}${template.displayName}`,
    description: `${template.id} · r${template.revision}`,
    template
  })), { placeHolder, matchOnDescription: true });
  return picked?.template || null;
}

function nextRevisionTemplate(template) {
  return {
    id: template.id,
    revision: template.revision + 1,
    displayName: template.displayName,
    fields: template.fields,
    directoryBlueprint: template.directoryBlueprint,
    markdownTemplates: template.markdownTemplates
  };
}

async function startTemplateDraft(vscode, root, template) {
  if (!template) return;
  const document = await vscode.workspace.openTextDocument({
    language: 'json',
    content: `${JSON.stringify(template, null, 2)}\n`
  });
  const mode = template.revision === 1 ? 'create' : 'update';
  drafts.set(document, {
    mode,
    rootUri: root.rootUri,
    rootId: root.inspection.config.rootId,
    templateId: template.id,
    expectedRevision: mode === 'update' ? template.revision - 1 : undefined
  });
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage('编辑 JSON 后运行“项目管理: 保存模板草稿”。');
}

module.exports = {
  manageTemplatesFlow,
  saveTemplateDraftFlow
};

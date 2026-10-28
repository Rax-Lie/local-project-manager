'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { manageTemplatesFlow, saveTemplateDraftFlow } = require('../../src/extension/ui/template-flow');

test('模板管理打开新建草稿并通过保存命令提交', async () => {
  const state = makeFlowState([{ action: 'create' }], ['research', '研究项目']);
  await manageTemplatesFlow(state.deps);
  const opened = JSON.parse(state.document.text);
  assert.equal(opened.id, 'research');
  assert.equal(opened.revision, 1);
  await saveTemplateDraftFlow(state.deps);
  assert.equal(state.calls[0].operation, 'template.validate');
  assert.equal(state.calls[1].operation, 'template.create');
  assert.equal(state.calls[1].payload.template.id, 'research');
  assert.equal(state.refreshes, 1);
});

test('编辑草稿自动递增 revision 并携带预期旧版本', async () => {
  const existing = {
    id: 'research', revision: 4, displayName: '研究项目', fields: [],
    directoryBlueprint: ['docs'], markdownTemplates: [], relativePath: '.pm/templates/research.json', enabled: true
  };
  const state = makeFlowState([{ action: 'edit' }, { template: existing }], []);
  state.listedTemplates = [existing];
  await manageTemplatesFlow(state.deps);
  const draft = JSON.parse(state.document.text);
  assert.equal(draft.revision, 5);
  assert.equal(Object.hasOwn(draft, 'enabled'), false);
  await saveTemplateDraftFlow(state.deps);
  const update = state.calls.find((item) => item.operation === 'template.update');
  assert.equal(update.payload.expectedRevision, 4);
  assert.equal(update.payload.template.revision, 5);
});

function makeFlowState(picks, inputValues) {
  const calls = [];
  const root = {
    rootUri: 'file:///tmp/project-manager',
    inspection: { initialized: true, config: { rootId: 'root_123456' } },
    error: null,
    projects: []
  };
  const document = { text: '', getText() { return this.text; } };
  const provider = { roots: [root], async refresh() {} };
  let refreshes = 0;
  provider.refresh = async () => { refreshes += 1; };
  const vscode = {
    window: {
      activeTextEditor: null,
      async showQuickPick() { return picks.shift(); },
      async showInputBox() { return inputValues.shift(); },
      async showWarningMessage() { return '删除模板'; },
      showInformationMessage() {}
    },
    workspace: {
      async openTextDocument(value) { document.text = value.content; return document; }
    }
  };
  vscode.window.showTextDocument = async (opened) => { vscode.window.activeTextEditor = { document: opened }; };
  const cli = {
    async request(operation, payload) {
      calls.push({ operation, payload });
      if (operation === 'template.list') return { templates: state.listedTemplates };
      if (operation === 'template.validate') return { valid: true, errors: [] };
      return { changed: true };
    }
  };
  const state = { calls, document, listedTemplates: [], refreshes: 0 };
  Object.defineProperty(state, 'refreshes', { get() { return refreshes; } });
  state.deps = { vscode, cli, provider };
  return state;
}

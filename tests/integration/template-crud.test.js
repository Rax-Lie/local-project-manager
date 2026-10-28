'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  makeTempDir,
  makeWorkspaceFile,
  removeAll,
  initRoot,
  createProject,
  fileUri
} = require('../helpers/temp');
const { runCli } = require('../helpers/cli');

test('模板支持创建、读取、版本更新、停用、恢复和软删除', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = JSON.parse(await fs.readFile(path.join(root, '.pm', 'pm.json'), 'utf8')).rootId;
  const project = await createProject(root, workspaceFile, { displayName: '模板快照保留' });
  const snapshotPath = path.join(root, ...project.pending.project.relativePath.split('/'), '.pm-project.json');
  await templateRequest(root, rootId, 'template.delete', {
    templateId: 'standard', expectedRevision: 1
  }, 'template-delete-used');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.equal(snapshot.templateId, 'standard');

  const created = await templateRequest(root, rootId, 'template.create', {
    template: makeTemplate(1, '研究项目')
  }, 'template-create');
  assert.equal(created.template.id, 'research');
  assert.equal(created.enabled, true);
  assert.equal(created.changed, true);

  const retried = await templateRequest(root, rootId, 'template.create', {
    template: makeTemplate(1, '研究项目')
  }, 'template-create-retry');
  assert.equal(retried.changed, false);

  const listed = await templateRequest(root, rootId, 'template.list', {}, 'template-list');
  const entry = listed.templates.find((item) => item.id === 'research');
  assert.equal(entry.displayName, '研究项目');
  assert.equal(entry.enabled, true);

  const updated = await templateRequest(root, rootId, 'template.update', {
    templateId: 'research',
    expectedRevision: 1,
    template: makeTemplate(2, '研究项目 2')
  }, 'template-update');
  assert.equal(updated.template.revision, 2);
  assert.equal(updated.template.displayName, '研究项目 2');

  const stale = await runTemplateRequest(root, rootId, 'template.update', {
    templateId: 'research',
    expectedRevision: 1,
    template: makeTemplate(2, '过期修改')
  }, 'template-stale-update');
  assert.equal(stale.json.ok, false);
  assert.equal(stale.json.error.code, 'CONFLICT');

  await templateRequest(root, rootId, 'template.setEnabled', {
    templateId: 'research', expectedRevision: 2, enabled: false
  }, 'template-disable');
  const disabled = await templateRequest(root, rootId, 'template.list', {}, 'template-list-disabled');
  assert.equal(disabled.templates.find((item) => item.id === 'research').enabled, false);
  const blockedPlan = await runTemplateRequest(root, rootId, 'project.create.plan', {
    templateId: 'research',
    expectedTemplateRevision: 2,
    displayName: '不可创建',
    fieldValues: {}
  }, 'disabled-project-plan');
  assert.equal(blockedPlan.json.ok, false);
  assert.equal(blockedPlan.json.error.code, 'CONFLICT');

  await templateRequest(root, rootId, 'template.setEnabled', {
    templateId: 'research', expectedRevision: 2, enabled: true
  }, 'template-enable');
  const enabledPlan = await runTemplateRequest(root, rootId, 'project.create.plan', {
    templateId: 'research',
    expectedTemplateRevision: 2,
    displayName: '可创建项目',
    fieldValues: {}
  }, 'enabled-project-plan');
  assert.equal(enabledPlan.json.ok, true, enabledPlan.stdout);

  const deleted = await templateRequest(root, rootId, 'template.delete', {
    templateId: 'research', expectedRevision: 2
  }, 'template-delete');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.retained, true);
  assert.equal(deleted.enabled, false);
  await fs.stat(path.join(root, '.pm', 'templates', 'research.json'));
});

test('模板创建校验 schema 并拒绝不同内容的重复 ID', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = JSON.parse(await fs.readFile(path.join(root, '.pm', 'pm.json'), 'utf8')).rootId;

  const invalid = await runTemplateRequest(root, rootId, 'template.create', {
    template: { ...makeTemplate(1), unsafe: true }
  }, 'template-invalid');
  assert.equal(invalid.json.ok, false);
  assert.equal(invalid.json.error.code, 'VALIDATION_FAILED');

  const created = await templateRequest(root, rootId, 'template.create', {
    template: makeTemplate(1)
  }, 'template-create-duplicate-base');
  assert.equal(created.changed, true);
  const duplicate = await runTemplateRequest(root, rootId, 'template.create', {
    template: makeTemplate(1, '不同内容')
  }, 'template-create-duplicate');
  assert.equal(duplicate.json.ok, false);
  assert.equal(duplicate.json.error.code, 'CONFLICT');
});

function makeTemplate(revision, displayName = '研究项目') {
  return {
    id: 'research',
    revision,
    displayName,
    fields: [],
    directoryBlueprint: ['docs'],
    markdownTemplates: []
  };
}

async function runTemplateRequest(root, rootId, operation, extra, requestId) {
  return runCli({
    protocolVersion: 1,
    requestId,
    operation,
    payload: { rootUri: fileUri(root), rootId, ...extra }
  });
}

async function templateRequest(root, rootId, operation, extra, requestId) {
  const response = await runTemplateRequest(root, rootId, operation, extra, requestId);
  assert.equal(response.json?.ok, true, response.stdout);
  return response.json.data;
}

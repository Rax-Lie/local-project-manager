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
  completeWorkspace,
  readRootConfig,
  fileUri
} = require('../helpers/temp');
const { runCli } = require('../helpers/cli');

async function setup(t, options = {}) {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  const init = await initRoot(root, workspaceFile);
  return { temp, root, workspaceFile, rootId: init.result.config.rootId };
}

test('project.create 创建全新目录、快照和 provisioning 记录，再完成工作区同步', async (t) => {
  const { root, workspaceFile } = await setup(t);
  const { pending } = await createProject(root, workspaceFile, {
    displayName: '示例项目',
    fieldValues: { description: '说明', owner: '张三', startDate: '2026-10-28', priority: '高' }
  });
  assert.equal(pending.state, 'awaiting_workspace');
  assert.equal(pending.requiresWorkspaceSync, true);
  assert.equal(pending.project.status, 'provisioning');
  assert.match(pending.project.slug, /^project-[a-f0-9]{8}$/);
  assert.equal(pending.workspaceSync.action, 'add');
  assert.ok(pending.workspaceSync.targetUri.startsWith('file:'));

  const projectDir = path.join(root, 'projects', pending.project.slug);
  assert.ok((await fs.stat(projectDir)).isDirectory());
  assert.ok((await fs.stat(path.join(projectDir, 'docs'))).isDirectory());
  assert.ok((await fs.stat(path.join(projectDir, 'docs', 'notes'))).isDirectory());
  assert.ok((await fs.stat(path.join(projectDir, 'assets'))).isDirectory());
  const snapshot = JSON.parse(await fs.readFile(path.join(projectDir, '.pm-project.json'), 'utf8'));
  assert.equal(snapshot.displayName, '示例项目');
  assert.equal(snapshot.fieldValues.priority, '高');

  const completed = await completeWorkspace(pending, root, workspaceFile);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.project.status, 'active');

  const search = await runCli({
    protocolVersion: 1,
    requestId: 'search-1',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), text: '示例' }
  });
  assert.equal(search.json.ok, true);
  assert.equal(search.json.data.items.length, 1);
  assert.equal(search.json.data.items[0].status, 'active');
});

test('同名项目自动获得不冲突的 slug', async (t) => {
  const { root, workspaceFile } = await setup(t);
  const first = await createProject(root, workspaceFile, { displayName: '重复名称' });
  await completeWorkspace(first.pending, root, workspaceFile);
  const second = await createProject(root, workspaceFile, { displayName: '重复名称' });
  assert.equal(second.pending.project.slug, `${first.pending.project.slug}-2`);
  assert.notEqual(second.pending.project.relativePath, first.pending.project.relativePath);
  await completeWorkspace(second.pending, root, workspaceFile);
});

test('项目目录已存在但数据库无记录时拒绝创建', async (t) => {
  const { root, workspaceFile } = await setup(t);
  await fs.mkdir(path.join(root, 'projects', 'conflict-project'));
  const rootId = (await readRootConfig(root)).rootId;
  const plan = await runCli({
    protocolVersion: 1,
    requestId: 'plan-conflict',
    operation: 'project.create.plan',
    payload: {
      rootUri: fileUri(root),
      rootId,
      templateId: 'blank',
      expectedTemplateRevision: 1,
      displayName: 'Conflict Project',
      fieldValues: {}
    }
  });
  assert.equal(plan.json.ok, true);
  assert.equal(plan.json.data.details.slug, 'conflict-project-2');
});

test('必填字段缺失或未知字段被拒绝', async (t) => {
  const { root, workspaceFile } = await setup(t);
  const rootId = (await readRootConfig(root)).rootId;
  const missing = await runCli({
    protocolVersion: 1,
    requestId: 'plan-missing',
    operation: 'project.create.plan',
    payload: {
      rootUri: fileUri(root),
      rootId,
      templateId: 'standard',
      expectedTemplateRevision: 1,
      displayName: '缺字段',
      fieldValues: { priority: null }
    }
  });
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, 'VALIDATION_FAILED');
  assert.match(missing.json.error.message, /优先级/);

  const extra = await runCli({
    protocolVersion: 1,
    requestId: 'plan-extra',
    operation: 'project.create.plan',
    payload: {
      rootUri: fileUri(root),
      rootId,
      templateId: 'blank',
      expectedTemplateRevision: 1,
      displayName: '额外字段',
      fieldValues: { nope: 1 }
    }
  });
  assert.equal(extra.json.ok, false);
  assert.match(extra.json.error.message, /未知模板字段/);

  const control = await runCli({
    protocolVersion: 1,
    requestId: 'plan-control',
    operation: 'project.create.plan',
    payload: {
      rootUri: fileUri(root),
      rootId,
      templateId: 'blank',
      expectedTemplateRevision: 1,
      displayName: '坏\n名称',
      fieldValues: {}
    }
  });
  assert.equal(control.json.ok, false);
  assert.equal(control.json.error.code, 'VALIDATION_FAILED');
});

test('工作区未观察到项目时保持 awaiting_workspace', async (t) => {
  const { root, workspaceFile } = await setup(t);
  const { pending, rootId } = await createProject(root, workspaceFile, { displayName: '待同步' });
  const response = await runCli({
    protocolVersion: 1,
    requestId: 'complete-missing',
    operation: 'project.workspace.complete',
    payload: {
      rootUri: fileUri(root),
      rootId,
      operationId: pending.operationId,
      observedPresent: false,
      action: 'add',
      targetUri: pending.workspaceSync.targetUri
    }
  });
  assert.equal(response.json.ok, true);
  assert.equal(response.json.data.state, 'awaiting_workspace');
  assert.equal(response.json.data.requiresWorkspaceSync, true);
  assert.equal(response.json.data.warnings[0].code, 'WORKSPACE_FOLDER_MISSING');
});

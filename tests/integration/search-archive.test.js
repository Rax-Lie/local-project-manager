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

async function setup(t) {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = (await readRootConfig(root)).rootId;
  const created = [];
  for (const [index, displayName] of ['Alpha One', 'Beta Two', 'Gamma Three'].entries()) {
    const item = await createProject(root, workspaceFile, {
      displayName,
      fieldValues: {
        priority: index === 0 ? '高' : '低',
        description: index === 0 ? '第一项目' : '',
        owner: ''
      }
    });
    await completeWorkspace(item.pending, root, workspaceFile);
    created.push(item.pending.project);
  }
  return { root, workspaceFile, rootId, created };
}

test('project.search 支持文本、状态、字段过滤和稳定分页', async (t) => {
  const { root, created } = await setup(t);
  const text = await runCli({
    protocolVersion: 1,
    requestId: 'search-text',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), text: 'Alpha' }
  });
  assert.equal(text.json.ok, true);
  assert.deepEqual(text.json.data.items.map((item) => item.displayName), ['Alpha One']);

  const status = await runCli({
    protocolVersion: 1,
    requestId: 'search-status',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), status: 'active' }
  });
  assert.equal(status.json.data.items.length, 3);

  const field = await runCli({
    protocolVersion: 1,
    requestId: 'search-field',
    operation: 'project.search',
    payload: {
      rootUri: fileUri(root),
      fieldFilters: [{ fieldId: 'priority', value: '高' }]
    }
  });
  assert.equal(field.json.ok, true, JSON.stringify(field.json));
  assert.deepEqual(field.json.data.items.map((item) => item.projectId), [created[0].projectId]);

  const first = await runCli({
    protocolVersion: 1,
    requestId: 'search-page-1',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), limit: 2 }
  });
  assert.equal(first.json.data.items.length, 2);
  assert.ok(first.json.data.nextCursor);
  const second = await runCli({
    protocolVersion: 1,
    requestId: 'search-page-2',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), limit: 2, cursor: first.json.data.nextCursor }
  });
  assert.equal(second.json.ok, true);
  assert.equal(second.json.data.items.length, 1);
  const ids = [...first.json.data.items, ...second.json.data.items].map((item) => item.projectId);
  assert.equal(new Set(ids).size, 3);

  const mismatch = await runCli({
    protocolVersion: 1,
    requestId: 'search-page-mismatch',
    operation: 'project.search',
    payload: { rootUri: fileUri(root), text: 'Alpha', cursor: first.json.data.nextCursor }
  });
  assert.equal(mismatch.json.ok, false);
  assert.equal(mismatch.json.error.code, 'VALIDATION_FAILED');
});

test('无效 limit、未知状态和 cursor 被拒绝', async (t) => {
  const { root } = await setup(t);
  for (const payload of [
    { limit: 0 },
    { limit: 999 },
    { status: 'unknown' },
    { fieldFilters: [{ fieldId: 'bad id', value: 1 }] },
    { cursor: 'not-base64' }
  ]) {
    const response = await runCli({
      protocolVersion: 1,
      requestId: 'search-invalid',
      operation: 'project.search',
      payload: { rootUri: fileUri(root), ...payload }
    });
    assert.equal(response.json.ok, false, JSON.stringify(payload));
    assert.equal(response.json.error.code, 'VALIDATION_FAILED');
  }
});

test('project.archive 移动目录、更新台账并完成工作区移除', async (t) => {
  const { root, workspaceFile, rootId, created } = await setup(t);
  const project = created[1];
  const planResponse = await runCli({
    protocolVersion: 1,
    requestId: 'archive-plan',
    operation: 'project.archive.plan',
    payload: { rootUri: fileUri(root), rootId, projectId: project.projectId }
  });
  assert.equal(planResponse.json.ok, true, planResponse.stdout);
  const plan = planResponse.json.data;
  assert.equal(plan.details.targetRelativePath, `archive/${project.slug}`);

  const execute = await runCli({
    protocolVersion: 1,
    requestId: 'archive-exec',
    operation: 'project.archive.execute',
    payload: {
      input: { rootUri: fileUri(root), rootId, projectId: project.projectId },
      plan
    }
  });
  assert.equal(execute.json.ok, true, execute.stdout);
  assert.equal(execute.json.data.state, 'awaiting_workspace');
  assert.equal(execute.json.data.requiresWorkspaceSync, true);
  assert.equal(execute.json.data.workspaceSync.action, 'remove');
  assert.equal(execute.json.data.project.status, 'archiving');
  await assert.rejects(fs.stat(path.join(root, ...project.relativePath.split('/'))));
  assert.ok((await fs.stat(path.join(root, 'archive', project.slug))).isDirectory());

  const complete = await runCli({
    protocolVersion: 1,
    requestId: 'archive-complete',
    operation: 'project.workspace.complete',
    payload: {
      rootUri: fileUri(root),
      rootId,
      operationId: execute.json.data.operationId,
      observedPresent: false,
      action: 'remove',
      targetUri: execute.json.data.workspaceSync.targetUri
    }
  });
  assert.equal(complete.json.ok, true, complete.stdout);
  assert.equal(complete.json.data.state, 'completed');
  assert.equal(complete.json.data.project.status, 'archived');
  assert.equal(complete.json.data.project.relativePath, `archive/${project.slug}`);
});

test('归档目标已存在时计划阻塞且执行被拒绝', async (t) => {
  const { root, rootId, created } = await setup(t);
  const project = created[2];
  await fs.mkdir(path.join(root, 'archive', project.slug), { recursive: true });
  const planResponse = await runCli({
    protocolVersion: 1,
    requestId: 'archive-conflict-plan',
    operation: 'project.archive.plan',
    payload: { rootUri: fileUri(root), rootId, projectId: project.projectId }
  });
  assert.equal(planResponse.json.ok, true);
  assert.equal(planResponse.json.data.details.conflict, true);
  const execute = await runCli({
    protocolVersion: 1,
    requestId: 'archive-conflict-exec',
    operation: 'project.archive.execute',
    payload: {
      input: { rootUri: fileUri(root), rootId, projectId: project.projectId },
      plan: planResponse.json.data
    }
  });
  assert.equal(execute.json.ok, false);
  assert.equal(execute.json.error.code, 'CONFLICT');
  assert.ok((await fs.stat(path.join(root, ...project.relativePath.split('/')))).isDirectory());
});

test('project.restore 将归档项目安全移回项目分区并重新同步工作区', async (t) => {
  const { root, rootId, created } = await setup(t);
  const project = created[0];
  const input = { rootUri: fileUri(root), rootId, projectId: project.projectId };
  const archivedPlan = await runCli({
    protocolVersion: 1, requestId: 'restore-archive-plan', operation: 'project.archive.plan', payload: input
  });
  const archived = await runCli({
    protocolVersion: 1, requestId: 'restore-archive', operation: 'project.archive.execute',
    payload: { input: { ...input, targetPartitionId: 'archive' }, plan: archivedPlan.json.data }
  });
  assert.equal(archived.json.ok, true, archived.stdout);
  const archiveDone = await runCli({
    protocolVersion: 1, requestId: 'restore-archive-done', operation: 'project.workspace.complete',
    payload: { rootUri: input.rootUri, rootId, operationId: archived.json.data.operationId, observedPresent: false, action: 'remove',
      targetUri: archived.json.data.workspaceSync.targetUri }
  });
  assert.equal(archiveDone.json.ok, true, archiveDone.stdout);
  assert.equal(archiveDone.json.data.project.status, 'archived');

  const plan = await runCli({ protocolVersion: 1, requestId: 'restore-plan', operation: 'project.restore.plan', payload: input });
  assert.equal(plan.json.ok, true, plan.stdout);
  assert.equal(plan.json.data.details.targetRelativePath, project.relativePath);
  const restored = await runCli({
    protocolVersion: 1, requestId: 'restore-execute', operation: 'project.restore.execute',
    payload: { input, plan: plan.json.data }
  });
  assert.equal(restored.json.ok, true, restored.stdout);
  assert.equal(restored.json.data.state, 'awaiting_workspace');
  assert.equal(restored.json.data.workspaceSync.action, 'add');
  await assert.rejects(fs.stat(path.join(root, 'archive', project.slug)));
  assert.ok((await fs.stat(path.join(root, ...project.relativePath.split('/')))).isDirectory());

  const completed = await runCli({
    protocolVersion: 1, requestId: 'restore-complete', operation: 'project.workspace.complete',
    payload: { rootUri: input.rootUri, rootId, operationId: restored.json.data.operationId, observedPresent: true, action: 'add',
      targetUri: restored.json.data.workspaceSync.targetUri }
  });
  assert.equal(completed.json.ok, true, completed.stdout);
  assert.equal(completed.json.data.project.status, 'active');
});

test('恢复目标冲突时不移动归档内容', async (t) => {
  const { root, rootId, created } = await setup(t);
  const project = created[0];
  const input = { rootUri: fileUri(root), rootId, projectId: project.projectId };
  const archivePlan = await runCli({ protocolVersion: 1, requestId: 'restore-conflict-archive-plan',
    operation: 'project.archive.plan', payload: input });
  const archived = await runCli({ protocolVersion: 1, requestId: 'restore-conflict-archive',
    operation: 'project.archive.execute', payload: { input: { ...input, targetPartitionId: 'archive' }, plan: archivePlan.json.data } });
  assert.equal(archived.json.ok, true, archived.stdout);
  const archiveDone = await runCli({ protocolVersion: 1, requestId: 'restore-conflict-archive-done', operation: 'project.workspace.complete',
    payload: { rootUri: input.rootUri, rootId, operationId: archived.json.data.operationId, observedPresent: false, action: 'remove',
      targetUri: archived.json.data.workspaceSync.targetUri } });
  assert.equal(archiveDone.json.ok, true, archiveDone.stdout);
  await fs.mkdir(path.join(root, ...project.relativePath.split('/')), { recursive: true });
  const response = await runCli({ protocolVersion: 1, requestId: 'restore-conflict-plan',
    operation: 'project.restore.plan', payload: input });
  assert.equal(response.json.ok, true, response.stdout);
  assert.equal(response.json.data.details.conflict, true);
  assert.ok((await fs.stat(path.join(root, 'archive', project.slug))).isDirectory());
});

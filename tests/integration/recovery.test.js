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
const { SqliteDatabase } = require('../../src/adapters/sqlite/database');

async function setOperationState(root, operationId, state) {
  const db = new SqliteDatabase(path.join(root, '.pm', 'pm.sqlite'));
  await db.open();
  try {
    const changes = db.run('UPDATE operations SET state = ? WHERE operation_id = ?', [state, operationId]).changes;
    assert.equal(changes, 1);
  } finally {
    db.close();
  }
}

async function recovery(root, rootId, apply) {
  const response = await runCli({
    protocolVersion: 1,
    requestId: apply ? 'recover-apply' : 'recover-inspect',
    operation: 'operation.recover',
    payload: { rootUri: fileUri(root), rootId, apply }
  });
  assert.equal(response.json.ok, true, response.stdout);
  return response.json.data;
}

test('project.create 在 applying 中断后可安全推进并在之后完成工作区同步', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = (await readRootConfig(root)).rootId;
  const created = await createProject(root, workspaceFile, { displayName: '恢复项目' });
  await setOperationState(root, created.pending.operationId, 'applying');

  const inspected = await recovery(root, rootId, false);
  const report = inspected.operations.find((item) => item.operationId === created.pending.operationId);
  assert.equal(report.action, 'resume');
  assert.equal(report.checks.every((check) => check.ok), true);

  const applied = await recovery(root, rootId, true);
  const recovered = applied.operations.find((item) => item.operationId === created.pending.operationId);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state, 'awaiting_workspace');

  const completed = await completeWorkspace(created.pending, root, workspaceFile);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.project.status, 'active');
});

test('project.file.write 在 applying 中断后按内容哈希补记完成', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = (await readRootConfig(root)).rootId;
  const created = await createProject(root, workspaceFile, { displayName: '文件恢复' });
  await completeWorkspace(created.pending, root, workspaceFile);
  const input = {
    rootUri: fileUri(root),
    rootId,
    projectId: created.pending.project.projectId,
    templateId: 'standard',
    expectedTemplateRevision: 1,
    markdownId: 'readme'
  };
  const plan = await runCli({
    protocolVersion: 1,
    requestId: 'recover-file-plan',
    operation: 'project.file.plan',
    payload: input
  });
  const executed = await runCli({
    protocolVersion: 1,
    requestId: 'recover-file-exec',
    operation: 'project.file.execute',
    payload: { input, plan: plan.json.data }
  });
  assert.equal(executed.json.ok, true, executed.stdout);
  await setOperationState(root, executed.json.data.operationId, 'applying');

  const applied = await recovery(root, rootId, true);
  const report = applied.operations.find((item) => item.operationId === executed.json.data.operationId);
  assert.equal(report.recovered, true);
  assert.equal(report.state, 'completed');
});

test('project.archive 在移动后、工作区移除前可恢复', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = (await readRootConfig(root)).rootId;
  const created = await createProject(root, workspaceFile, { displayName: '归档恢复' });
  await completeWorkspace(created.pending, root, workspaceFile);
  const plan = await runCli({
    protocolVersion: 1,
    requestId: 'recover-archive-plan',
    operation: 'project.archive.plan',
    payload: { rootUri: fileUri(root), rootId, projectId: created.pending.project.projectId }
  });
  const executed = await runCli({
    protocolVersion: 1,
    requestId: 'recover-archive-exec',
    operation: 'project.archive.execute',
    payload: {
      input: {
        rootUri: fileUri(root),
        rootId,
        projectId: created.pending.project.projectId,
        targetPartitionId: 'archive'
      },
      plan: plan.json.data
    }
  });
  assert.equal(executed.json.ok, true, executed.stdout);
  await setOperationState(root, executed.json.data.operationId, 'applying');

  const applied = await recovery(root, rootId, true);
  const report = applied.operations.find((item) => item.operationId === executed.json.data.operationId);
  assert.equal(report.recovered, true);
  assert.equal(report.state, 'awaiting_workspace');
  assert.equal(report.action, 'workspace_sync');

  const complete = await runCli({
    protocolVersion: 1,
    requestId: 'recover-archive-complete',
    operation: 'project.workspace.complete',
    payload: {
      rootUri: fileUri(root),
      rootId,
      operationId: executed.json.data.operationId,
      observedPresent: false,
      action: 'remove',
      targetUri: executed.json.data.workspaceSync.targetUri
    }
  });
  assert.equal(complete.json.ok, true, complete.stdout);
  assert.equal(complete.json.data.project.status, 'archived');
});

test('root.initialize 在 applying 中断后可补记完成', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  const init = await initRoot(root, workspaceFile);
  const rootId = init.result.config.rootId;
  await setOperationState(root, init.plan.operationId, 'applying');
  const applied = await recovery(root, rootId, true);
  const report = applied.operations.find((item) => item.operationId === init.plan.operationId);
  assert.equal(report.recovered, true);
  assert.equal(report.state, 'completed');
});

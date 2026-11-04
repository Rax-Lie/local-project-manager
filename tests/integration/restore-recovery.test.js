'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeTempDir, makeWorkspaceFile, removeAll, initRoot, createProject, completeWorkspace, readRootConfig, fileUri } = require('../helpers/temp');
const { runCli } = require('../helpers/cli');
const { withRootContext } = require('../../src/application/context');
const { createOperationRecord } = require('../../src/domain/operation');

test('恢复在目录移动后中断时可补记台账并等待工作区同步', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const rootId = (await readRootConfig(root)).rootId;
  const created = await createProject(root, workspaceFile, { displayName: '恢复故障注入' });
  await completeWorkspace(created.pending, root, workspaceFile);
  const input = { rootUri: fileUri(root), rootId, projectId: created.pending.project.projectId };
  const archivePlan = await request('project.archive.plan', input, 'restore-crash-archive-plan');
  const archived = await request('project.archive.execute', { input: { ...input, targetPartitionId: 'archive' }, plan: archivePlan }, 'restore-crash-archive');
  await request('project.workspace.complete', {
    rootUri: input.rootUri, rootId, operationId: archived.operationId, observedPresent: false,
    action: 'remove', targetUri: archived.workspaceSync.targetUri
  }, 'restore-crash-archive-done');
  const plan = await request('project.restore.plan', input, 'restore-crash-plan');

  await withRootContext(input.rootUri, async (context) => {
    await context.journal.begin(createOperationRecord({
      operationId: plan.operationId, rootId, kind: 'project.restore', state: 'applying',
      projectId: input.projectId, sourceRelativePath: plan.details.sourceRelativePath,
      targetRelativePath: plan.details.targetRelativePath, payload: { input, plan }
    }));
    await context.fs.moveNoReplace(plan.details.sourceRelativePath, plan.details.targetRelativePath);
  });
  const dryRun = await request('operation.recover', { rootUri: input.rootUri, rootId, apply: false }, 'restore-crash-inspect');
  assert.equal(dryRun.operations[0].action, 'resume');
  const recovered = await request('operation.recover', { rootUri: input.rootUri, rootId, apply: true }, 'restore-crash-apply');
  assert.equal(recovered.operations[0].state, 'awaiting_workspace');
  assert.equal(recovered.operations[0].action, 'workspace_sync');
  const complete = await request('project.workspace.complete', {
    rootUri: input.rootUri, rootId, operationId: plan.operationId, observedPresent: true,
    action: 'add', targetUri: fileUri(path.join(root, ...plan.details.targetRelativePath.split('/')))
  }, 'restore-crash-complete');
  assert.equal(complete.project.status, 'active');
});

async function request(operation, payload, requestId) {
  const response = await runCli({ protocolVersion: 1, requestId, operation, payload });
  assert.equal(response.json.ok, true, response.stdout);
  return response.json.data;
}

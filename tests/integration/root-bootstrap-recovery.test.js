'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ROOT_INIT_MARKER } = require('../../src/shared/constants');
const {
  makeTempDir,
  makeWorkspaceFile,
  removeAll,
  planRootInit,
  fileUri
} = require('../helpers/temp');
const { runCli } = require('../helpers/cli');

const CRASH_POINTS = [
  'bootstrap_marker',
  'pm_directory',
  'database_open',
  'journal_begin',
  'templates_directory',
  'backups_directory',
  'partition_inbox',
  'partition_projects',
  'partition_archive',
  'config_write',
  'template_standard',
  'template_blank',
  'template_index',
  'integrity_check',
  'journal_complete',
  'marker_removed'
];

for (const point of CRASH_POINTS) {
  test(`根初始化在 ${point} 后崩溃时可恢复或保持完整`, async (t) => {
    const temp = await makeTempDir();
    const root = path.join(temp, 'root');
    await fs.mkdir(root);
    const workspaceFile = await makeWorkspaceFile(temp);
    t.after(() => removeAll([temp]));
    const { plan } = await planRootInit(root, workspaceFile, { requestId: `plan-${point}` });
    const interrupted = await runCli({
      protocolVersion: 1,
      requestId: `execute-${point}`,
      operation: 'root.initialize.execute',
      payload: {
        input: {
          rootUri: fileUri(root),
          workspaceUri: fileUri(workspaceFile),
          displayName: '测试管理根'
        },
        plan
      }
    }, {
      env: { PM_TEST_FAILPOINTS: '1', PM_TEST_CRASH_AFTER: point }
    });
    assert.equal(interrupted.status, 86, interrupted.stdout || interrupted.stderr);

    if (point === 'marker_removed') {
      const inspection = await inspectRoot(root, `inspect-${point}`);
      assert.equal(inspection.initialized, true);
      assert.equal(inspection.partial, false);
      await assert.rejects(fs.stat(path.join(root, ROOT_INIT_MARKER)));
      return;
    }

    const partial = await inspectRoot(root, `inspect-${point}`);
    assert.equal(partial.partial, true);
    assert.equal(partial.bootstrapOperationId, plan.operationId);
    const inspected = await recover(root, `recover-inspect-${point}`, false);
    assert.equal(inspected.operations[0].action, 'resume');
    assert.ok(inspected.operations[0].checks.every((item) => item.ok), JSON.stringify(inspected.operations[0].checks));

    const recovered = await recover(root, `recover-apply-${point}`, true);
    assert.equal(recovered.operations[0].recovered, true);
    assert.equal(recovered.operations[0].state, 'completed');
    const complete = await inspectRoot(root, `inspect-complete-${point}`);
    assert.equal(complete.initialized, true);
    assert.equal(complete.partial, false);
    await assert.rejects(fs.stat(path.join(root, ROOT_INIT_MARKER)));
  });
}

test('恢复发现配置被用户修改时停止且不覆盖', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  const { plan } = await planRootInit(root, workspaceFile);
  await runCli({
    protocolVersion: 1,
    requestId: 'execute-config-conflict',
    operation: 'root.initialize.execute',
    payload: {
      input: {
        rootUri: fileUri(root),
        workspaceUri: fileUri(workspaceFile),
        displayName: '测试管理根'
      },
      plan
    }
  }, { env: { PM_TEST_FAILPOINTS: '1', PM_TEST_CRASH_AFTER: 'config_write' } });
  const configPath = path.join(root, '.pm', 'pm.json');
  await fs.writeFile(configPath, '{"user":"keep"}\n', 'utf8');

  const result = await recover(root, 'recover-config-conflict', true);
  assert.equal(result.operations[0].action, 'manual');
  assert.equal(result.operations[0].recovered, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), '{"user":"keep"}\n');
  await fs.stat(path.join(root, ROOT_INIT_MARKER));
});

async function inspectRoot(root, requestId) {
  const response = await runCli({
    protocolVersion: 1,
    requestId,
    operation: 'root.inspect',
    payload: { rootUri: fileUri(root) }
  });
  assert.equal(response.json?.ok, true, response.stdout);
  return response.json.data;
}

async function recover(root, requestId, apply) {
  const response = await runCli({
    protocolVersion: 1,
    requestId,
    operation: 'operation.recover',
    payload: { rootUri: fileUri(root), apply }
  });
  assert.equal(response.json?.ok, true, response.stdout);
  return response.json.data;
}

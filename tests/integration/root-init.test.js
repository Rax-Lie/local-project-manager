'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  makeTempDir,
  makeWorkspaceFile,
  removeAll,
  planRootInit,
  initRoot,
  fileUri
} = require('../helpers/temp');
const { runCli } = require('../helpers/cli');

test('root.initialize 在空目录创建配置、模板、分区和数据库', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));

  const { plan } = await planRootInit(root, workspaceFile);
  assert.equal(plan.summary.warnings.length, 0);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.ok(plan.details.rootId.startsWith('root_'));

  const { result } = await initRoot(root, workspaceFile, { plan });
  assert.equal(result.state, 'completed');
  assert.equal(result.requiresWorkspaceSync, false);

  const config = JSON.parse(await fs.readFile(path.join(root, '.pm', 'pm.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.rootId, plan.details.rootId);
  assert.equal(config.displayName, '测试管理根');
  assert.equal(config.workspaceUri, fileUri(workspaceFile));
  assert.equal(config.partitions.length, 3);

  for (const relative of ['inbox', 'projects', 'archive', '.pm/templates', '.pm/backups']) {
    const stat = await fs.stat(path.join(root, ...relative.split('/')));
    assert.ok(stat.isDirectory(), `${relative} should be directory`);
  }
  const templates = await fs.readdir(path.join(root, '.pm', 'templates'));
  assert.deepEqual(templates.sort(), ['blank.json', 'standard.json']);
  const dbStat = await fs.stat(path.join(root, '.pm', 'pm.sqlite'));
  assert.ok(dbStat.size > 0);
});

test('inspect 返回已初始化状态且无未完成操作', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);

  const response = await runCli({
    protocolVersion: 1,
    requestId: 'inspect-1',
    operation: 'root.inspect',
    payload: { rootUri: fileUri(root) }
  });
  assert.equal(response.status, 0);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.data.initialized, true);
  assert.equal(response.json.data.partial, false);
  assert.equal(response.json.data.database.quickCheck, 'ok');
  assert.deepEqual(response.json.data.incompleteOperations, []);
});

test('重复初始化幂等且不覆盖已有配置', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  const before = await fs.readFile(path.join(root, '.pm', 'pm.json'), 'utf8');

  const { plan } = await planRootInit(root, workspaceFile);
  assert.equal(plan.details.alreadyInitialized, true);
  const { result } = await initRoot(root, workspaceFile);
  assert.equal(result.state, 'completed');
  const after = await fs.readFile(path.join(root, '.pm', 'pm.json'), 'utf8');
  assert.equal(before, after);
});

test('非空目录只生成带阻塞警告的计划，执行被拒绝', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'user-file.txt'), 'keep me', 'utf8');
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));

  const { plan } = await planRootInit(root, workspaceFile);
  assert.equal(plan.details.blocking, true);
  assert.equal(plan.summary.warnings[0].code, 'ROOT_NOT_EMPTY');

  const response = await runCli({
    protocolVersion: 1,
    requestId: 'root-exec-nonempty',
    operation: 'root.initialize.execute',
    payload: {
      input: {
        rootUri: fileUri(root),
        workspaceUri: fileUri(workspaceFile),
        displayName: '测试管理根'
      },
      plan
    }
  });
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'VALIDATION_FAILED');
  assert.equal(await fs.readFile(path.join(root, 'user-file.txt'), 'utf8'), 'keep me');
  await assert.rejects(fs.stat(path.join(root, '.pm')));
});

test('分区目录缺失时 inspect 标记 partial 并拒绝重新初始化', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspaceFile);
  await fs.rm(path.join(root, 'projects'), { recursive: true, force: true });

  const inspect = await runCli({
    protocolVersion: 1,
    requestId: 'inspect-partial',
    operation: 'root.inspect',
    payload: { rootUri: fileUri(root) }
  });
  assert.equal(inspect.json.ok, true);
  assert.equal(inspect.json.data.initialized, true);
  assert.equal(inspect.json.data.partial, true);
  assert.ok(inspect.json.data.issues.some((item) => item.code === 'PARTITION_MISSING'));

  const plan = await runCli({
    protocolVersion: 1,
    requestId: 'plan-partial',
    operation: 'root.initialize.plan',
    payload: {
      rootUri: fileUri(root),
      workspaceUri: fileUri(workspaceFile),
      displayName: '测试管理根'
    }
  });
  assert.equal(plan.json.ok, false);
  assert.equal(plan.json.error.code, 'RECOVERY_REQUIRED');
});

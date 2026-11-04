'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  makeTempDir, makeWorkspaceFile, removeAll, initRoot, createProject, completeWorkspace, readRootConfig, fileUri
} = require('../helpers/temp');
const { runCli } = require('../helpers/cli');

test('暂存扫描只读取直接子项，忽略决策持久化且来源目录不变', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'managed');
  const scanRoot = path.join(temp, 'incoming');
  await fs.mkdir(root);
  await fs.mkdir(scanRoot);
  const workspace = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspace);
  const rootId = (await readRootConfig(root)).rootId;
  const ignoredDir = path.join(scanRoot, '旧资料');
  const sourceDir = path.join(scanRoot, '新门户');
  await fs.mkdir(ignoredDir);
  await fs.writeFile(path.join(ignoredDir, 'README.md'), 'keep');
  await fs.mkdir(path.join(ignoredDir, 'docs'));
  await fs.mkdir(path.join(sourceDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'package.json'), '{"name":"sample"}');
  await fs.mkdir(path.join(scanRoot, '.hidden'));
  await fs.writeFile(path.join(scanRoot, '.hidden', 'package.json'), '{}');
  const original = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8');
  const input = { rootUri: fileUri(root), rootId, scanRootUri: fileUri(scanRoot) };

  const first = await request('project.stage.scan', input, 'stage-first-scan');
  assert.equal(first.candidates.length, 2);
  assert.ok(first.candidates[0].score >= 50);
  assert.ok(first.candidates[0].reasons.length > 0);
  const ignored = first.candidates.find((item) => item.displayName === '旧资料');
  await request('project.stage.decide', {
    rootUri: input.rootUri, rootId, candidateId: ignored.candidateId, decision: 'ignored'
  }, 'stage-ignore');

  const candidate = first.candidates.find((item) => item.displayName === '新门户');
  const project = await createProject(root, workspace, { displayName: '新门户工作副本' });
  await completeWorkspace(project.pending, root, workspace);
  await request('project.stage.decide', {
    rootUri: input.rootUri, rootId, candidateId: candidate.candidateId,
    decision: 'accepted', projectId: project.pending.project.projectId
  }, 'stage-accept');

  const repeated = await request('project.stage.scan', input, 'stage-rescan');
  assert.deepEqual(repeated.candidates, []);
  assert.equal(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'), original);
  assert.ok((await fs.stat(sourceDir)).isDirectory());
});

test('弱特征目录不会生成低置信度建议，成功扫描会清理已消失的待处理项', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'managed');
  const scanRoot = path.join(temp, 'incoming');
  await fs.mkdir(root);
  await fs.mkdir(scanRoot);
  const workspace = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspace);
  const rootId = (await readRootConfig(root)).rootId;
  const candidatePath = path.join(scanRoot, 'candidate');
  await fs.mkdir(candidatePath);
  await fs.writeFile(path.join(candidatePath, 'package.json'), '{}');
  const input = { rootUri: fileUri(root), rootId, scanRootUri: fileUri(scanRoot) };
  const first = await scan(input, 'stage-stale-first');
  assert.equal(first.candidates.length, 0);
  await fs.mkdir(path.join(candidatePath, 'src'));
  assert.equal((await scan(input, 'stage-stale-second')).candidates.length, 1);
  await fs.rm(candidatePath, { recursive: true });
  assert.equal((await scan(input, 'stage-stale-third')).candidates.length, 0);
});

test('暂存扫描拒绝管理根及其父目录', async (t) => {
  const temp = await makeTempDir();
  const root = path.join(temp, 'managed');
  await fs.mkdir(root);
  const workspace = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  await initRoot(root, workspace);
  const rootId = (await readRootConfig(root)).rootId;
  const response = await runCli({
    protocolVersion: 1, requestId: 'stage-overlap', operation: 'project.stage.scan',
    payload: { rootUri: fileUri(root), rootId, scanRootUri: fileUri(temp) }
  });
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'VALIDATION_FAILED');
});

async function request(operation, payload, requestId) {
  const response = await runCli({ protocolVersion: 1, requestId, operation, payload });
  assert.equal(response.json.ok, true, response.stdout);
  return response.json.data;
}

async function scan(payload, requestId) {
  return request('project.stage.scan', payload, requestId);
}

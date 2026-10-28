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
  const created = await createProject(root, workspaceFile, {
    displayName: '文件模板项目',
    fieldValues: { description: '这是说明', owner: '李四', priority: '中' }
  });
  await completeWorkspace(created.pending, root, workspaceFile);
  return { root, workspaceFile, project: created.pending.project };
}

test('project.file 预览渲染变量并写入新文件', async (t) => {
  const { root, project } = await setup(t);
  const rootId = (await readRootConfig(root)).rootId;
  const input = {
    rootUri: fileUri(root),
    rootId,
    projectId: project.projectId,
    templateId: 'standard',
    expectedTemplateRevision: 1,
    markdownId: 'readme'
  };
  const planResponse = await runCli({
    protocolVersion: 1,
    requestId: 'file-plan',
    operation: 'project.file.plan',
    payload: input
  });
  assert.equal(planResponse.json.ok, true, planResponse.stdout);
  const plan = planResponse.json.data;
  assert.match(plan.details.content, /文件模板项目/);
  assert.match(plan.details.content, /这是说明/);
  assert.match(plan.details.content, /李四/);
  assert.equal(plan.details.blocking, false);

  const executeResponse = await runCli({
    protocolVersion: 1,
    requestId: 'file-exec',
    operation: 'project.file.execute',
    payload: { input, plan }
  });
  assert.equal(executeResponse.json.ok, true, executeResponse.stdout);
  assert.equal(executeResponse.json.data.state, 'completed');
  const content = await fs.readFile(path.join(root, project.relativePath, 'README.md'), 'utf8');
  assert.match(content, /文件模板项目/);
  assert.doesNotMatch(content, /\$\{/);
});

test('目标文件已存在时不覆盖', async (t) => {
  const { root, project } = await setup(t);
  const rootId = (await readRootConfig(root)).rootId;
  const readme = path.join(root, project.relativePath, 'README.md');
  await fs.writeFile(readme, '用户已有内容', 'utf8');
  const input = {
    rootUri: fileUri(root),
    rootId,
    projectId: project.projectId,
    templateId: 'standard',
    expectedTemplateRevision: 1,
    markdownId: 'readme'
  };
  const planResponse = await runCli({
    protocolVersion: 1,
    requestId: 'file-plan-conflict',
    operation: 'project.file.plan',
    payload: input
  });
  assert.equal(planResponse.json.ok, true);
  assert.equal(planResponse.json.data.details.blocking, true);
  const executeResponse = await runCli({
    protocolVersion: 1,
    requestId: 'file-exec-conflict',
    operation: 'project.file.execute',
    payload: { input, plan: planResponse.json.data }
  });
  assert.equal(executeResponse.json.ok, false);
  assert.equal(executeResponse.json.error.code, 'CONFLICT');
  assert.equal(await fs.readFile(readme, 'utf8'), '用户已有内容');
});

test('未知变量被拒绝且不写入文件', async (t) => {
  const { root, project } = await setup(t);
  const rootId = (await readRootConfig(root)).rootId;
  const custom = {
    id: 'custom',
    revision: 1,
    displayName: '未知变量',
    fields: [],
    directoryBlueprint: [],
    markdownTemplates: [{
      id: 'readme',
      targetPath: 'CUSTOM.md',
      content: '# ${project.displayName}\n${unknown.value}\n'
    }]
  };
  await fs.writeFile(
    path.join(root, '.pm', 'templates', 'custom.json'),
    JSON.stringify(custom, null, 2),
    'utf8'
  );
  const input = {
    rootUri: fileUri(root),
    rootId,
    projectId: project.projectId,
    templateId: 'custom',
    expectedTemplateRevision: 1,
    markdownId: 'readme'
  };
  const response = await runCli({
    protocolVersion: 1,
    requestId: 'file-unknown-var',
    operation: 'project.file.plan',
    payload: input
  });
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'VALIDATION_FAILED');
  assert.match(response.json.error.message, /unknown.value/);
  await assert.rejects(fs.stat(path.join(root, project.relativePath, 'CUSTOM.md')));
});

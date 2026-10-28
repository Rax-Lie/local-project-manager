'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkspaceAdapter } = require('../../src/extension/workspace-adapter');
const { makeTempDir, makeWorkspaceFile, removeAll } = require('../helpers/temp');

function makeUri(fsPath) {
  return {
    scheme: 'file',
    fsPath,
    toString() { return pathToFileURL(fsPath).href; }
  };
}

function makeHost(workspaceFile, folders = []) {
  const state = {
    workspaceFile: workspaceFile ? makeUri(workspaceFile) : undefined,
    workspaceFolders: folders.map((item) => ({ uri: makeUri(item.path), name: item.name }))
  };
  state.Uri = { file: (target) => makeUri(target) };
  state.workspace = state;
  state.workspace.updateWorkspaceFolders = (start, deleteCount, ...items) => {
    state.workspaceFolders.splice(start, deleteCount, ...items.map((item) => ({
      uri: item.uri,
      name: item.name
    })));
    return true;
  };
  return state;
}

test('addFolder 追加别名并持久化到当前工作区对象', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  const project = path.join(temp, 'projects', 'demo');
  await fs.mkdir(project, { recursive: true });
  t.after(() => removeAll([temp]));
  const host = makeHost(workspaceFile);
  const adapter = new WorkspaceAdapter(host);
  const result = await adapter.addFolder(makeUri(project).toString(), '演示项目', makeUri(workspaceFile).toString());
  assert.deepEqual(result, { observedPresent: true, already: false });
  assert.equal(host.workspaceFolders.length, 1);
  assert.equal(host.workspaceFolders[0].name, '演示项目');
  assert.equal(adapter.contains(makeUri(project).toString()), true);
});

test('addFolder 幂等，不重复添加', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  const project = path.join(temp, 'demo');
  await fs.mkdir(project);
  t.after(() => removeAll([temp]));
  const host = makeHost(workspaceFile);
  const adapter = new WorkspaceAdapter(host);
  const uri = makeUri(project).toString();
  const configUri = makeUri(workspaceFile).toString();
  await adapter.addFolder(uri, '演示', configUri);
  const second = await adapter.addFolder(uri, '演示', configUri);
  assert.equal(second.already, true);
  assert.equal(host.workspaceFolders.length, 1);
});

test('错误工作区被拒绝', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  const otherWorkspace = path.join(temp, 'other.code-workspace');
  await fs.writeFile(otherWorkspace, '{}', 'utf8');
  const project = path.join(temp, 'demo');
  await fs.mkdir(project);
  t.after(() => removeAll([temp]));
  const host = makeHost(workspaceFile);
  const adapter = new WorkspaceAdapter(host);
  await assert.rejects(
    adapter.addFolder(makeUri(project).toString(), '演示', makeUri(otherWorkspace).toString()),
    (error) => error.code === 'CONFLICT'
  );
});

test('父文件夹已打开时拒绝重叠工作区', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  const parent = path.join(temp, 'work');
  const project = path.join(parent, 'demo');
  await fs.mkdir(project, { recursive: true });
  t.after(() => removeAll([temp]));
  const host = makeHost(workspaceFile, [{ path: parent, name: 'work' }]);
  const adapter = new WorkspaceAdapter(host);
  await assert.rejects(
    adapter.addFolder(makeUri(project).toString(), '演示', makeUri(workspaceFile).toString()),
    /父文件夹/
  );
});

test('removeFolder 移除工作区项，不存在时幂等返回', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  const project = path.join(temp, 'demo');
  await fs.mkdir(project);
  t.after(() => removeAll([temp]));
  const host = makeHost(workspaceFile);
  const adapter = new WorkspaceAdapter(host);
  const uri = makeUri(project).toString();
  const configUri = makeUri(workspaceFile).toString();
  await adapter.addFolder(uri, '演示', configUri);
  const removed = await adapter.removeFolder(uri, configUri);
  assert.deepEqual(removed, { observedPresent: false, already: false });
  assert.equal(host.workspaceFolders.length, 0);
  const again = await adapter.removeFolder(uri, configUri);
  assert.equal(again.already, true);
});

test('无工作区文件、非目录目标和跨 scheme 被拒绝', async (t) => {
  const temp = await makeTempDir();
  const workspaceFile = await makeWorkspaceFile(temp);
  t.after(() => removeAll([temp]));
  const noWorkspace = new WorkspaceAdapter(makeHost(null));
  await assert.rejects(
    noWorkspace.addFolder(makeUri(temp).toString(), 'x', makeUri(workspaceFile).toString()),
    /没有打开/
  );

  const host = makeHost(workspaceFile);
  const adapter = new WorkspaceAdapter(host);
  await assert.rejects(
    adapter.addFolder(makeUri(path.join(temp, 'missing')).toString(), 'x', makeUri(workspaceFile).toString()),
    /不存在/
  );
  const fileTarget = path.join(temp, 'file.txt');
  await fs.writeFile(fileTarget, 'x', 'utf8');
  await assert.rejects(
    adapter.addFolder(makeUri(fileTarget).toString(), 'x', makeUri(workspaceFile).toString()),
    /不是普通目录/
  );
});

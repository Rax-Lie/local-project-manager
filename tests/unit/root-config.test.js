'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  createRootConfig,
  validateRootConfig,
  serializeRootConfig,
  projectRelativePath
} = require('../../src/domain/root-config');

const workspaceUri = pathToFileURL(path.join('C:', 'work', 'demo.code-workspace')).href;
const rootId = 'root_12345678-1234-1234-1234-123456789abc';

test('createRootConfig 填充默认分区和 slug 规则', () => {
  const config = createRootConfig({
    rootId,
    displayName: '演示根',
    workspaceUri
  });
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.configRevision, 1);
  assert.deepEqual(config.partitions.map((item) => item.id), ['inbox', 'projects', 'archive']);
  assert.deepEqual(config.slugRules, {
    pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
    maxLength: 64,
    lowercase: true
  });
  assert.equal(projectRelativePath(config, 'demo'), 'projects/demo');
  const parsed = JSON.parse(serializeRootConfig(config));
  assert.equal(parsed.workspaceUri, workspaceUri);
});

test('分区必须完整、唯一且不能嵌套或进入 .pm', () => {
  const base = { rootId, displayName: '根', workspaceUri };
  assert.throws(() => validateRootConfig({
    ...base,
    schemaVersion: 1,
    configRevision: 1,
    partitions: [],
    slugRules: undefined
  }), /三个分区/);
  assert.throws(() => validateRootConfig({
    ...base,
    schemaVersion: 1,
    configRevision: 1,
    partitions: [
      { id: 'inbox', name: '收件箱', relativePath: 'a' },
      { id: 'projects', name: '项目', relativePath: 'a/b' },
      { id: 'archive', name: '归档', relativePath: 'archive' }
    ],
    slugRules: undefined
  }), /嵌套/);
  assert.throws(() => validateRootConfig({
    ...base,
    schemaVersion: 1,
    configRevision: 1,
    partitions: [
      { id: 'inbox', name: '收件箱', relativePath: '.pm/inbox' },
      { id: 'projects', name: '项目', relativePath: 'projects' },
      { id: 'archive', name: '归档', relativePath: 'archive' }
    ],
    slugRules: undefined
  }), /\.pm/);
});

test('slugRules 和根字段校验', () => {
  assert.throws(() => createRootConfig({
    rootId: 'bad',
    displayName: '根',
    workspaceUri
  }), /rootId/);
  assert.throws(() => createRootConfig({
    rootId,
    displayName: '',
    workspaceUri
  }), /显示名称/);
  assert.throws(() => createRootConfig({
    rootId,
    displayName: '根',
    workspaceUri,
    slugRules: { pattern: '([a-z]', maxLength: 64, lowercase: true }
  }), /正则/);
  assert.throws(() => createRootConfig({
    rootId,
    displayName: '根',
    workspaceUri,
    slugRules: { pattern: '^[a-z]+$', maxLength: 7, lowercase: true }
  }), /maxLength/);
  assert.throws(() => validateRootConfig({
    schemaVersion: 1,
    rootId,
    displayName: '根',
    workspaceUri: pathToFileURL(path.join('C:', 'work', 'not-workspace.txt')).href,
    configRevision: 1,
    partitions: undefined,
    slugRules: undefined
  }), /\.code-workspace/);
});

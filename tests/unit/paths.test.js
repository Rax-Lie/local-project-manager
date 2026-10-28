'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  normalizeRelativePath,
  isPathInsideOrEqual,
  fileUriToPath,
  pathToFileUri,
  normalizeFileUri,
  sameFileUri,
  validateWorkspaceFileUri
} = require('../../src/shared/paths');

test('normalizeRelativePath 接受普通、中文和空格路径', () => {
  assert.equal(normalizeRelativePath('docs/notes'), 'docs/notes');
  assert.equal(normalizeRelativePath('工作/记录 2026'), '工作/记录 2026');
  assert.equal(normalizeRelativePath('a\\b\\c'), 'a/b/c');
});

test('normalizeRelativePath 拒绝逃逸和 Windows 危险名称', () => {
  const bad = [
    '..',
    '../x',
    'a/../b',
    '/absolute',
    '\\absolute',
    'C:/drive',
    '//server/share',
    'a//b',
    'CON',
    'aux.txt',
    'name.',
    'name ',
    'bad:name',
    'bad\u0000name'
  ];
  for (const value of bad) {
    assert.throws(() => normalizeRelativePath(value), (error) => Boolean(error.code), value);
  }
});

test('isPathInsideOrEqual 防止前缀伪装', () => {
  const parent = path.join('C:', 'root');
  assert.equal(isPathInsideOrEqual(parent, path.join(parent, 'a')), true);
  assert.equal(isPathInsideOrEqual(parent, path.join(parent, '..', 'other')), false);
});

test('file URI 转换与比较', () => {
  const file = path.join('C:', 'work', '项目', 'test.code-workspace');
  const uri = pathToFileUri(file);
  assert.equal(fileUriToPath(uri), file);
  assert.equal(normalizeFileUri(uri), uri);
  assert.equal(sameFileUri(uri, pathToFileUri(file)), true);
  assert.equal(sameFileUri(uri, pathToFileUri(`${file}x`)), false);
  assert.equal(validateWorkspaceFileUri(uri), uri);
  assert.throws(() => validateWorkspaceFileUri(pathToFileUri(path.join('C:', 'x', 'a.txt'))));
  assert.throws(() => fileUriToPath('https://example.com/x'));
  assert.throws(() => fileUriToPath('file:///C:/x?query=1'));
});

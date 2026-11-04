'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { extractMarkdownLinks } = require('../../src/domain/markdown-links');
const { checkMarkdownLinks } = require('../../src/extension/markdown-link-checker');
const { makeTempDir, removeAll } = require('../helpers/temp');

test('Markdown 链接提取跳过代码并支持嵌套括号、引用式链接和 HTML 属性', () => {
  const text = [
    '[inline](docs/api(v2).md?view=1#top)',
    '[escaped](docs/api\\(draft\\).md "title")',
    '[guide][docs]',
    '[docs]: <./Read%20Me.md#start>',
    '<img src="assets/logo.svg">',
    '`[inline code](ignored.md)`',
    '```md',
    '[fenced](ignored-too.md)',
    '```',
    '\\[escaped](ignored-three.md)'
  ].join('\n');
  const links = extractMarkdownLinks(text);
  assert.deepEqual(links.map((item) => item.destination), [
    'docs/api(v2).md?view=1#top', 'docs/api(draft).md', './Read%20Me.md#start', 'assets/logo.svg'
  ]);
  assert.deepEqual(links.map((item) => item.kind), ['inline', 'inline', 'reference', 'html']);
});

test('本地链接检查忽略外部 URL、查询和片段，报告缺失、越界、绝对路径和坏编码', async (t) => {
  const root = await makeTempDir();
  t.after(() => removeAll([root]));
  const docs = path.join(root, 'docs');
  await fs.mkdir(docs);
  await fs.writeFile(path.join(root, 'Read Me.md'), 'ok');
  const markdown = [
    '[ok](../Read%20Me.md?mode=1#section)',
    '[web](https://example.com/a.md)',
    '[missing](missing.md)',
    '[escape](../../../secret.txt)',
    '[drive](C:/private/file.md)',
    '[unc](//server/share/file.md)',
    '[encoding](bad%2)',
    '<a href="../Read%20Me.md#title">ok</a>'
  ].join('\n');
  const issues = await checkMarkdownLinks(markdown, path.join(docs, 'index.md'), [root]);
  assert.deepEqual(issues.map((item) => item.code), [
    'TARGET_MISSING', 'PATH_ESCAPE', 'ABSOLUTE_LINK', 'ABSOLUTE_LINK', 'INVALID_URL_ENCODING'
  ]);
});

test('链接通过符号链接逃逸时报告工作区路径越界', async (t) => {
  const parent = await makeTempDir();
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'private');
  await fs.symlink(outside, path.join(root, 'linked'), 'junction');
  t.after(() => removeAll([parent]));
  const issues = await checkMarkdownLinks('[secret](linked/secret.md)', path.join(root, 'index.md'), [root]);
  assert.equal(issues[0].code, 'PATH_ESCAPE');
});

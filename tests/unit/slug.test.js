'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, validateSlug, slugCandidates, fallbackSlug } = require('../../src/shared/slug');
const { DEFAULT_SLUG_RULES } = require('../../src/shared/constants');

test('slugify 处理 ASCII 名称', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('  A  B  '), 'a-b');
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu');
});

test('slugify 对纯中文名称生成稳定哈希 slug', () => {
  const first = slugify('示例项目');
  const second = slugify('示例项目');
  assert.equal(first, second);
  assert.match(first, /^project-[a-f0-9]{8}$/);
  assert.equal(fallbackSlug('示例项目'), first);
});

test('slugify 处理保留名和超长名称', () => {
  assert.equal(slugify('CON'), 'con-project');
  const long = slugify('a'.repeat(120));
  assert.equal(long.length, DEFAULT_SLUG_RULES.maxLength);
  assert.equal(validateSlug(long), long);
});

test('validateSlug 拒绝大写、非法字符和保留名', () => {
  assert.throws(() => validateSlug('ABC'));
  assert.throws(() => validateSlug('bad space'));
  assert.throws(() => validateSlug('con'));
});

test('slugCandidates 追加 -2 且保持长度限制', () => {
  const candidates = slugCandidates('demo', DEFAULT_SLUG_RULES, 3);
  assert.deepEqual(candidates, ['demo', 'demo-2', 'demo-3']);
  const longCandidates = slugCandidates('a'.repeat(64), DEFAULT_SLUG_RULES, 2);
  assert.equal(longCandidates[1].length, 64);
  assert.ok(longCandidates[1].endsWith('-2'));
});

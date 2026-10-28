'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlainObject,
  assertJsonValue,
  canonicalJson,
  hashJson,
  parseJson
} = require('../../src/shared/json');

test('canonicalJson 按字典序排列对象键', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
});

test('assertJsonValue 拒绝非 JSON 值', () => {
  assert.equal(assertJsonValue({ a: [1, 'x', true, null] }).a[1], 'x');
  assert.throws(() => assertJsonValue({ a: undefined }), /JSON/);
  assert.throws(() => assertJsonValue({ a: NaN }), /NaN/);
  assert.throws(() => assertJsonValue({ a: () => 1 }), /JSON/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => assertJsonValue(circular), /嵌套过深/);
});

test('isPlainObject 排除数组和类实例', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
});

test('parseJson 将语法错误转为 INVALID_REQUEST', () => {
  assert.throws(() => parseJson('{oops', '请求'), (error) => error.code === 'INVALID_REQUEST');
});

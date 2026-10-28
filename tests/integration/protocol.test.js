'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('../helpers/cli');

const valid = {
  protocolVersion: 1,
  requestId: 'protocol-1',
  operation: 'system.health',
  payload: {}
};

test('健康检查成功且 stdout 只有一行 JSON', async () => {
  const response = await runCli(valid);
  assert.equal(response.status, 0);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.requestId, 'protocol-1');
  assert.equal(response.json.data.protocolVersion, 1);
  assert.equal(response.json.data.sqlite.available, true);
  assert.equal(response.stdout.trim().split(/\r?\n/).length, 1);
});

test('空输入、空白、无效 UTF-8、无效 JSON 被拒绝', async () => {
  const inputs = [
    Buffer.alloc(0),
    Buffer.from('   \n\t ', 'utf8'),
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from('{', 'utf8'),
    Buffer.from('{"a":1}\n{"b":2}', 'utf8')
  ];
  for (const input of inputs) {
    const response = await runCli(input);
    assert.equal(response.status, 0);
    assert.equal(response.json?.ok, false, String(input));
    assert.equal(response.json.error.code, 'INVALID_REQUEST');
    assert.equal(response.json.requestId, '');
  }
});

test('null、数组、字符串等非对象请求被拒绝', async () => {
  for (const input of ['null', '[]', '"hello"', '42', 'true']) {
    const response = await runCli(input);
    assert.equal(response.json.ok, false, input);
    assert.equal(response.json.error.code, 'INVALID_REQUEST');
  }
});

test('缺字段、未知字段和未知操作被拒绝且回显 requestId', async () => {
  const cases = [
    { ...valid, operation: undefined },
    { ...valid, requestId: undefined },
    { ...valid, extra: 1 },
    { ...valid, operation: 'unknown.op' }
  ];
  for (const request of cases) {
    const response = await runCli(request);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.error.code, 'INVALID_REQUEST');
    assert.equal(
      response.json.requestId,
      request.requestId === undefined ? '' : 'protocol-1'
    );
  }
  const payloadArray = await runCli({ ...valid, payload: [] });
  assert.equal(payloadArray.json.error.code, 'INVALID_REQUEST');
  const unknownPayload = await runCli({ ...valid, payload: { nope: 1 } });
  assert.equal(unknownPayload.json.error.code, 'VALIDATION_FAILED');
});

test('不支持的协议版本返回 UNSUPPORTED_PROTOCOL', async () => {
  const response = await runCli({ ...valid, protocolVersion: 2 });
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'UNSUPPORTED_PROTOCOL');
  assert.equal(response.json.requestId, 'protocol-1');
});

test('超过请求字节上限时拒绝且不读取完整内容', async () => {
  const huge = {
    ...valid,
    payload: { supportedProtocolVersions: [1], padding: 'x'.repeat(1024 * 1024 + 10) }
  };
  const response = await runCli(huge);
  assert.equal(response.status, 0);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'INVALID_REQUEST');
  assert.match(response.json.error.message, /上限/);
  assert.equal(response.stdout.trim().split(/\r?\n/).length, 1);
});

test('无效请求不会向 stdout 写诊断信息', async () => {
  const response = await runCli('{bad');
  assert.equal(response.stdout.trim().split(/\r?\n/).length, 1);
  assert.match(response.stderr, /project-manager-cli/);
});

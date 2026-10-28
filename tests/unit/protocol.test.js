'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRequestEnvelope,
  successResponse,
  errorResponse,
  assertPayloadKeys
} = require('../../src/shared/protocol');
const { AppError } = require('../../src/shared/errors');

const base = {
  protocolVersion: 1,
  requestId: 'req-1',
  operation: 'system.health',
  payload: {}
};

test('合法请求信封通过校验', () => {
  assert.deepEqual(validateRequestEnvelope(base), base);
});

test('缺字段、未知字段、错误类型被拒绝', () => {
  assert.throws(() => validateRequestEnvelope(null), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => validateRequestEnvelope([]), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => validateRequestEnvelope({ ...base, extra: 1 }), /未知字段/);
  assert.throws(() => validateRequestEnvelope({ ...base, requestId: '' }), /requestId/);
  assert.throws(() => validateRequestEnvelope({ ...base, operation: 'unknown.op' }), /未知操作/);
  assert.throws(() => validateRequestEnvelope({ ...base, payload: [] }), /payload/);
  assert.throws(() => validateRequestEnvelope({ ...base, protocolVersion: 1.5 }), /protocolVersion/);
});

test('不支持的协议版本返回 UNSUPPORTED_PROTOCOL', () => {
  assert.throws(
    () => validateRequestEnvelope({ ...base, protocolVersion: 99 }),
    (error) => error.code === 'UNSUPPORTED_PROTOCOL'
  );
});

test('响应信封包含协议版本、requestId 和 ok', () => {
  assert.deepEqual(successResponse('req-1', { x: 1 }), {
    protocolVersion: 1,
    requestId: 'req-1',
    ok: true,
    data: { x: 1 }
  });
  const error = errorResponse('req-1', new AppError('VALIDATION_FAILED', 'bad'));
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'VALIDATION_FAILED');
  assert.equal(error.error.retryable, false);
});

test('assertPayloadKeys 拒绝未知 payload 字段', () => {
  assert.doesNotThrow(() => assertPayloadKeys({ a: 1 }, ['a'], 'test'));
  assert.throws(() => assertPayloadKeys({ a: 1, b: 2 }, ['a'], 'test'), /未知字段/);
});

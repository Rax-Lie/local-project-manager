'use strict';

const { AppError } = require('./errors');
const { ERROR_CODES, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = require('./constants');
const { isPlainObject } = require('./json');

const OPERATIONS = Object.freeze([
  'system.health',
  'root.inspect',
  'root.initialize.plan',
  'root.initialize.execute',
  'template.list',
  'template.validate',
  'template.create',
  'template.update',
  'template.delete',
  'template.setEnabled',
  'project.create.plan',
  'project.create.execute',
  'project.workspace.complete',
  'project.search',
  'project.archive.plan',
  'project.archive.execute',
  'project.restore.plan',
  'project.restore.execute',
  'project.stage.scan',
  'project.stage.decide',
  'project.file.plan',
  'project.file.execute',
  'operation.recover'
]);

const OPERATION_SET = new Set(OPERATIONS);
const ENVELOPE_KEYS = new Set(['protocolVersion', 'requestId', 'operation', 'payload']);

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertRequestId(value, label = 'requestId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 必须是 1–128 字符的字符串。`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 不能包含控制字符。`);
  }
}

/**
 * 严格校验请求信封：未知字段、类型错误和协议版本都在这里拒绝。
 * @param {unknown} request
 * @returns {{protocolVersion: number, requestId: string, operation: string, payload: Record<string, unknown>}}
 */
function validateRequestEnvelope(request) {
  if (!isPlainObject(request)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '请求必须是 JSON 对象。');
  }
  for (const key of Object.keys(request)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `请求包含未知字段：${key}`);
    }
  }
  if (typeof request.protocolVersion !== 'number' || !Number.isInteger(request.protocolVersion)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'protocolVersion 必须是整数。');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(request.protocolVersion)) {
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_PROTOCOL,
      `不支持的协议版本 ${request.protocolVersion}，当前支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}。`
    );
  }
  assertRequestId(request.requestId);
  if (typeof request.operation !== 'string' || !OPERATION_SET.has(request.operation)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `未知操作：${String(request.operation)}`);
  }
  if (!isPlainObject(request.payload)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'payload 必须是 JSON 对象。');
  }
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    operation: request.operation,
    payload: request.payload
  };
}

/**
 * @param {string} requestId
 * @param {unknown} data
 */
function successResponse(requestId, data) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: true,
    data
  };
}

/**
 * @param {string} requestId
 * @param {import('./errors').AppError} error
 */
function errorResponse(requestId, error) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: error.toJSON()
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string[]} allowed
 * @param {string} [label]
 */
function assertPayloadKeys(payload, allowed, label = 'payload') {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(payload)) {
    if (!allowedSet.has(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含未知字段：${key}`);
    }
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string[]} required
 */
function assertRequiredFields(payload, required) {
  for (const key of required) {
    if (!(key in payload)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `缺少必填字段：${key}`);
    }
  }
}

module.exports = {
  OPERATIONS,
  OPERATION_SET,
  validateRequestEnvelope,
  successResponse,
  errorResponse,
  assertPayloadKeys,
  assertRequiredFields,
  assertRequestId
};

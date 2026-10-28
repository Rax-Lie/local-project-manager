'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject, canonicalJson, sha256Hex, assertJsonValue } = require('../shared/json');

const PLAN_KEYS = new Set([
  'planId',
  'digest',
  'operationId',
  'expectedConfigRevision',
  'expectedTemplateRevision',
  'summary',
  'details'
]);
const PLAN_ID_PATTERN = /^plan_[A-Za-z0-9-]{6,128}$/;
const OPERATION_ID_PATTERN = /^op_[A-Za-z0-9-]{6,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * 摘要绑定规范化输入、配置/模板 revision 和预期目标。
 * @param {{kind: string, input: unknown, expectedConfigRevision: number, expectedTemplateRevision?: number, target: unknown}} data
 * @returns {string}
 */
function computePlanDigest(data) {
  return sha256Hex(canonicalJson({
    kind: data.kind,
    input: data.input,
    expectedConfigRevision: data.expectedConfigRevision,
    expectedTemplateRevision: data.expectedTemplateRevision ?? null,
    target: data.target
  }));
}

/**
 * @param {{kind: string, planId: string, operationId: string, input: unknown, expectedConfigRevision: number, expectedTemplateRevision?: number, target: unknown, summary: object, details?: object}} input
 * @returns {object}
 */
function createPlan(input) {
  if (typeof input.planId !== 'string' || !PLAN_ID_PATTERN.test(input.planId)) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, '生成计划时 planId 无效。');
  }
  if (typeof input.operationId !== 'string' || !OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, '生成计划时 operationId 无效。');
  }
  if (!Number.isInteger(input.expectedConfigRevision) || input.expectedConfigRevision < 1) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, '生成计划时 expectedConfigRevision 无效。');
  }
  if (input.expectedTemplateRevision !== undefined) {
    if (!Number.isInteger(input.expectedTemplateRevision) || input.expectedTemplateRevision < 1) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, '生成计划时 expectedTemplateRevision 无效。');
    }
  }
  const digest = computePlanDigest({
    kind: input.kind,
    input: input.input,
    expectedConfigRevision: input.expectedConfigRevision,
    expectedTemplateRevision: input.expectedTemplateRevision,
    target: input.target
  });
  const plan = {
    planId: input.planId,
    digest,
    operationId: input.operationId,
    expectedConfigRevision: input.expectedConfigRevision,
    summary: input.summary || { title: '', lines: [], warnings: [] },
    details: input.details || {}
  };
  if (input.expectedTemplateRevision !== undefined) {
    plan.expectedTemplateRevision = input.expectedTemplateRevision;
  }
  assertJsonValue(plan, '计划');
  return plan;
}

/**
 * 执行前重新计算摘要；配置、模板或目标变化都会拒绝旧计划。
 * @param {unknown} plan
 * @param {{kind: string, input: unknown, expectedConfigRevision: number, expectedTemplateRevision?: number, target: unknown}} expected
 * @returns {object}
 */
function verifyPlan(plan, expected) {
  if (!isPlainObject(plan)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少有效的 ConfirmedPlan。');
  }
  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `计划包含未知字段：${key}`);
    }
  }
  if (typeof plan.planId !== 'string' || !PLAN_ID_PATTERN.test(plan.planId)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'planId 格式无效。');
  }
  if (typeof plan.operationId !== 'string' || !OPERATION_ID_PATTERN.test(plan.operationId)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'operationId 格式无效。');
  }
  if (!Number.isInteger(plan.expectedConfigRevision) || plan.expectedConfigRevision < 1) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '预期配置版本无效。');
  }
  if (typeof plan.digest !== 'string' || !DIGEST_PATTERN.test(plan.digest)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '计划摘要格式无效。');
  }
  const digest = computePlanDigest(expected);
  if (digest !== plan.digest) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      '计划已过期：输入、配置或模板在确认后发生变化，请重新预览。',
      { details: { expectedDigest: digest } }
    );
  }
  if (plan.expectedConfigRevision !== expected.expectedConfigRevision) {
    throw new AppError(ERROR_CODES.CONFLICT, '根配置版本已变化，请重新预览。');
  }
  if (expected.expectedTemplateRevision !== undefined
    && plan.expectedTemplateRevision !== expected.expectedTemplateRevision) {
    throw new AppError(ERROR_CODES.CONFLICT, '模板版本已变化，请重新预览。');
  }
  return plan;
}

module.exports = {
  computePlanDigest,
  createPlan,
  verifyPlan
};

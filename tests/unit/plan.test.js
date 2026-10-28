'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlan,
  verifyPlan,
  computePlanDigest
} = require('../../src/domain/plan');

const operationId = 'op_12345678-1234-1234-1234-123456789abc';
const planId = 'plan_12345678-1234-1234-1234-123456789abc';

function makePlan(overrides = {}) {
  return createPlan({
    kind: 'project.create',
    planId,
    operationId,
    input: { displayName: 'Demo' },
    expectedConfigRevision: 1,
    expectedTemplateRevision: 1,
    target: { slug: 'demo', path: 'projects/demo' },
    summary: { title: 't', lines: [], warnings: [] },
    ...overrides
  });
}

test('计划摘要绑定输入、revision 和目标', () => {
  const plan = makePlan();
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(plan.digest, computePlanDigest({
    kind: 'project.create',
    input: { displayName: 'Demo' },
    expectedConfigRevision: 1,
    expectedTemplateRevision: 1,
    target: { slug: 'demo', path: 'projects/demo' }
  }));
});

test('verifyPlan 接受匹配计划并拒绝输入或 revision 变化', () => {
  const plan = makePlan();
  const expected = {
    kind: 'project.create',
    input: { displayName: 'Demo' },
    expectedConfigRevision: 1,
    expectedTemplateRevision: 1,
    target: { slug: 'demo', path: 'projects/demo' }
  };
  assert.equal(verifyPlan(plan, expected), plan);
  assert.throws(() => verifyPlan(plan, { ...expected, expectedConfigRevision: 2 }),
    (error) => error.code === 'CONFLICT');
  assert.throws(() => verifyPlan(plan, { ...expected, input: { displayName: 'Other' } }),
    (error) => error.code === 'CONFLICT');
  assert.throws(() => verifyPlan(plan, { ...expected, target: { slug: 'other', path: 'projects/other' } }),
    (error) => error.code === 'CONFLICT');
});

test('verifyPlan 拒绝未知字段和篡改摘要', () => {
  const plan = makePlan();
  assert.throws(() => verifyPlan({ ...plan, evil: true }, {
    kind: 'project.create',
    input: { displayName: 'Demo' },
    expectedConfigRevision: 1,
    expectedTemplateRevision: 1,
    target: { slug: 'demo', path: 'projects/demo' }
  }), /未知字段/);
  assert.throws(() => verifyPlan({ ...plan, digest: '0'.repeat(64) }, {
    kind: 'project.create',
    input: { displayName: 'Demo' },
    expectedConfigRevision: 1,
    expectedTemplateRevision: 1,
    target: { slug: 'demo', path: 'projects/demo' }
  }), (error) => error.code === 'CONFLICT');
});

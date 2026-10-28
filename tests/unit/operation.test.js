'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOperationRecord,
  validateOperationRecord,
  canTransitionOperation,
  assertOperationTransition,
  isIncompleteState
} = require('../../src/domain/operation');

const rootId = 'root_12345678-1234-1234-1234-123456789abc';
const operationId = 'op_12345678-1234-1234-1234-123456789abc';

test('操作记录校验和状态机', () => {
  const record = createOperationRecord({
    operationId,
    rootId,
    kind: 'project.create',
    state: 'applying',
    payload: { x: 1 }
  });
  assert.equal(validateOperationRecord(record), record);
  assert.equal(canTransitionOperation('applying', 'awaiting_workspace'), true);
  assert.equal(canTransitionOperation('awaiting_workspace', 'applying'), false);
  assert.doesNotThrow(() => assertOperationTransition('applying', 'completed'));
  assert.throws(() => assertOperationTransition('completed', 'applying'), (error) => error.code === 'OPERATION_INCOMPLETE');
  assert.equal(isIncompleteState('needs_recovery'), true);
  assert.equal(isIncompleteState('completed'), false);
});

test('非法操作字段被拒绝', () => {
  assert.throws(() => createOperationRecord({
    operationId: 'bad',
    rootId,
    kind: 'project.create'
  }), /operationId/);
  assert.throws(() => createOperationRecord({
    operationId,
    rootId,
    kind: 'unknown'
  }), /未知操作类型/);
  assert.throws(() => createOperationRecord({
    operationId,
    rootId,
    kind: 'project.create',
    state: 'done'
  }), /未知操作状态/);
  assert.throws(() => createOperationRecord({
    operationId,
    rootId,
    kind: 'project.create',
    payload: { bad: undefined }
  }), /JSON/);
});

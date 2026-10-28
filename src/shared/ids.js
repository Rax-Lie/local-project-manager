'use strict';

const crypto = require('node:crypto');

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function newRootId() {
  return newId('root');
}

function newProjectId() {
  return newId('prj');
}

function newOperationId() {
  return newId('op');
}

function newPlanId() {
  return newId('plan');
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  newId,
  newRootId,
  newProjectId,
  newOperationId,
  newPlanId,
  nowIso
};

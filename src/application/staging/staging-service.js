'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { isPlainObject } = require('../../shared/json');
const { fileUriToPath, normalizeFileUri, isPathInsideOrEqual } = require('../../shared/paths');
const { nowIso } = require('../../shared/ids');
const { scanProjectCandidates } = require('../../adapters/filesystem/staging-scanner');
const { withRootContext } = require('../context');
const { assertRootId } = require('../template-service');

async function scanStaging(payload) {
  const input = normalizeScanInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    const scanRootPath = path.resolve(fileUriToPath(input.scanRootUri));
    const [realRoot, realScanRoot] = await Promise.all([
      fs.realpath(context.rootPath), fs.realpath(scanRootPath)
    ]);
    assertExternalScanPath(realRoot, realScanRoot);
    const candidates = await scanProjectCandidates(scanRootPath);
    const scannedAt = nowIso();
    context.stagingIndex.upsertScan(context.config.rootId, scanRootPath, candidates, scannedAt);
    return {
      scanRootUri: input.scanRootUri,
      scannedAt,
      candidateCount: candidates.length,
      candidates: context.stagingIndex.listPending(context.config.rootId, scanRootPath)
    };
  });
}

async function decideStagingSuggestion(payload) {
  const input = normalizeDecisionInput(payload);
  return withRootContext(input.rootUri, async (context) => {
    assertRootId(context.config.rootId, input.rootId);
    if (input.decision === 'accepted') {
      const project = await context.repo.getById(input.projectId);
      if (!project || !['active', 'provisioning'].includes(project.status)) {
        throw new AppError(ERROR_CODES.CONFLICT, '确认候选时必须关联此管理根下的新建项目。');
      }
    }
    const saved = context.stagingIndex.decide(
      context.config.rootId, input.candidateId, input.decision, input.projectId, nowIso()
    );
    if (!saved) throw new AppError(ERROR_CODES.CONFLICT, '候选已不存在或已由其他操作处理。');
    return { candidateId: input.candidateId, decision: input.decision, projectId: input.projectId || null };
  });
}

function normalizeScanInput(payload) {
  assertObject(payload, 'project.stage.scan');
  assertKeys(payload, ['rootUri', 'rootId', 'scanRootUri'], 'project.stage.scan');
  return {
    rootUri: normalizeFileUri(payload.rootUri), rootId: payload.rootId,
    scanRootUri: normalizeFileUri(payload.scanRootUri)
  };
}

function normalizeDecisionInput(payload) {
  assertObject(payload, 'project.stage.decide');
  assertKeys(payload, ['rootUri', 'rootId', 'candidateId', 'decision', 'projectId'], 'project.stage.decide');
  if (typeof payload.candidateId !== 'string' || !/^cand_[a-f0-9]{24}$/.test(payload.candidateId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'candidateId 格式无效。');
  }
  if (!['ignored', 'accepted'].includes(payload.decision)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'decision 必须是 ignored 或 accepted。');
  }
  if (payload.decision === 'accepted' && typeof payload.projectId !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'accepted 决策必须包含 projectId。');
  }
  if (payload.decision === 'ignored' && payload.projectId !== undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'ignored 决策不能包含 projectId。');
  }
  return {
    rootUri: normalizeFileUri(payload.rootUri), rootId: payload.rootId,
    candidateId: payload.candidateId, decision: payload.decision, projectId: payload.projectId
  };
}

function assertExternalScanPath(rootPath, scanPath) {
  if (isPathInsideOrEqual(rootPath, scanPath) || isPathInsideOrEqual(scanPath, rootPath)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '扫描目录不能与管理根重叠。');
  }
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} payload 必须是对象。`);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含未知字段：${key}`);
  }
}

module.exports = { scanStaging, decideStagingSuggestion };

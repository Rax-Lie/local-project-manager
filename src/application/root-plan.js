'use strict';

const { AppError } = require('../shared/errors');
const {
  ERROR_CODES,
  PM_DIR,
  BACKUPS_DIR,
  MAX_DISPLAY_NAME_CHARS
} = require('../shared/constants');
const { isPlainObject, hashJson } = require('../shared/json');
const { hasControlCharacters } = require('../shared/text');
const {
  fileUriToPath,
  normalizeFileUri,
  sameFileUri,
  validateWorkspaceFileUri
} = require('../shared/paths');
const { newRootId, newOperationId, newPlanId } = require('../shared/ids');
const {
  normalizePartitions,
  normalizeSlugRules,
  createRootConfig
} = require('../domain/root-config');
const { validateTemplate } = require('../domain/template');
const { createPlan } = require('../domain/plan');
const { DEFAULT_TEMPLATES } = require('./defaults');
const { inspectRoot } = require('./root-inspect');
const {
  CONFIG_RELATIVE_PATH,
  DB_RELATIVE_PATH,
  TEMPLATES_RELATIVE_DIR,
  serializeTemplate
} = require('./context');

const INPUT_KEYS = ['rootUri', 'workspaceUri', 'displayName', 'partitions', 'slugRules'];
const ROOT_ID_PATTERN = /^root_[A-Za-z0-9-]{6,128}$/;

/**
 * @param {unknown} input
 * @returns {{rootUri: string, workspaceUri: string, displayName: string, partitions: object[], slugRules: object}}
 */
function normalizeInitializationInput(input) {
  if (!isPlainObject(input)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '初始化输入必须是 JSON 对象。');
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `初始化输入包含未知字段：${key}`);
    }
  }
  const rootUri = normalizeFileUri(input.rootUri);
  const workspaceUri = validateWorkspaceFileUri(input.workspaceUri);
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '管理根显示名称必须是 1–120 字符。');
  }
  if (hasControlCharacters(displayName)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '管理根显示名称不能包含控制字符。');
  }
  return {
    rootUri,
    workspaceUri,
    displayName,
    partitions: normalizePartitions(input.partitions),
    slugRules: normalizeSlugRules(input.slugRules)
  };
}

/**
 * @param {unknown} plan
 * @returns {string}
 */
function rootIdFromPlan(plan) {
  const rootId = plan?.details?.rootId;
  if (typeof rootId !== 'string' || !ROOT_ID_PATTERN.test(rootId)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '计划缺少有效的根 ID。');
  }
  return rootId;
}

/**
 * @param {object} inspection
 */
function assertRootDirectory(inspection) {
  if (!inspection.exists) {
    throw new AppError(ERROR_CODES.CONFLICT, '根目录不存在。', { retryable: false });
  }
  if (inspection.isSymlink || inspection.issues.some((item) => item.code === 'ROOT_REPARSE_POINT')) {
    throw new AppError(ERROR_CODES.PATH_ESCAPE, '根目录是符号链接或 junction，已拒绝。');
  }
  if (inspection.isDirectory === false) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '所选路径不是普通目录。');
  }
}

/**
 * @param {object} input
 * @returns {Promise<object>}
 */
async function planRootInitialization(input) {
  const normalized = normalizeInitializationInput(input);
  const inspection = await inspectRoot({ rootUri: normalized.rootUri });
  assertRootDirectory(inspection);

  if (inspection.initialized && !inspection.partial) {
    const config = inspection.config;
    if (!sameFileUri(config.workspaceUri, normalized.workspaceUri)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `该管理根已绑定其他工作区：${fileUriToPath(config.workspaceUri)}。`,
        { details: { configuredWorkspaceUri: config.workspaceUri } }
      );
    }
    if (hashJson(config.partitions) !== hashJson(normalized.partitions)
      || hashJson(config.slugRules) !== hashJson(normalized.slugRules)) {
      throw new AppError(ERROR_CODES.CONFLICT, '管理根已初始化，且分区或 slug 规则与当前输入不同。');
    }
    return createPlan({
      kind: 'root.initialize',
      planId: newPlanId(),
      operationId: newOperationId(),
      input: normalized,
      expectedConfigRevision: config.configRevision,
      target: {
        rootUri: normalized.rootUri,
        workspaceUri: normalized.workspaceUri,
        rootId: config.rootId
      },
      summary: {
        title: '管理根已初始化',
        lines: [`管理根：${inspection.rootPath}`, `显示名称：${config.displayName}`],
        warnings: []
      },
      details: { alreadyInitialized: true, rootId: config.rootId, config }
    });
  }
  if (inspection.partial) {
    throw new AppError(
      ERROR_CODES.RECOVERY_REQUIRED,
      '管理根存在未完成或损坏的初始化痕迹，请先运行“检查未完成操作”，不要重复初始化。'
    );
  }

  const blocking = !inspection.isEmpty;
  const rootId = newRootId();
  const config = createRootConfig({
    rootId,
    displayName: normalized.displayName,
    workspaceUri: normalized.workspaceUri,
    partitions: normalized.partitions,
    slugRules: normalized.slugRules
  });
  const templateEntries = DEFAULT_TEMPLATES.map((template) => {
    validateTemplate(template);
    return serializeTemplate(template);
  });
  const warnings = blocking ? [{
    code: 'ROOT_NOT_EMPTY',
    severity: 'error',
    message: '所选根目录不是空目录。为保护已有数据，初始化不会执行；请选择空目录。'
  }] : [];
  const changedPaths = [
    PM_DIR,
    CONFIG_RELATIVE_PATH,
    DB_RELATIVE_PATH,
    TEMPLATES_RELATIVE_DIR,
    `${PM_DIR}/${BACKUPS_DIR}`,
    ...normalized.partitions.map((partition) => partition.relativePath),
    ...templateEntries.map((entry) => entry.relativePath)
  ];
  return createPlan({
    kind: 'root.initialize',
    planId: newPlanId(),
    operationId: newOperationId(),
    input: normalized,
    expectedConfigRevision: 1,
    target: {
      rootUri: normalized.rootUri,
      workspaceUri: normalized.workspaceUri,
      rootId,
      partitions: normalized.partitions,
      slugRules: normalized.slugRules
    },
    summary: {
      title: '初始化项目管理根',
      lines: [
        `管理根：${inspection.rootPath}`,
        `显示名称：${normalized.displayName}`,
        `目标工作区：${fileUriToPath(normalized.workspaceUri)}`,
        `目录分区：${normalized.partitions.map((item) => `${item.name} (${item.relativePath})`).join('、')}`,
        `内置模板：${DEFAULT_TEMPLATES.map((item) => item.displayName).join('、')}`,
        '将创建 .pm/pm.json、.pm/pm.sqlite、模板目录、备份目录和分区目录。'
      ],
      warnings
    },
    details: {
      rootId,
      config,
      templateFiles: templateEntries.map((entry) => entry.relativePath),
      changedPaths,
      blocking
    }
  });
}

module.exports = {
  normalizeInitializationInput,
  rootIdFromPlan,
  assertRootDirectory,
  planRootInitialization
};

'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, DEFAULT_PARTITIONS, DEFAULT_SLUG_RULES, ROOT_SCHEMA_VERSION } = require('../shared/constants');
const { hasControlCharacters } = require('../shared/text');
const {
  normalizeRelativePath,
  requireRelativePath,
  validateWorkspaceFileUri
} = require('../shared/paths');

const ROOT_CONFIG_KEYS = new Set([
  'schemaVersion',
  'rootId',
  'displayName',
  'workspaceUri',
  'configRevision',
  'partitions',
  'slugRules'
]);
const PARTITION_IDS = Object.freeze(['inbox', 'projects', 'archive']);

/**
 * @param {unknown} config
 * @returns {{schemaVersion: number, rootId: string, displayName: string, workspaceUri: string, configRevision: number, partitions: Array<{id: string, name: string, relativePath: string}>, slugRules: {pattern: string, maxLength: number, lowercase: boolean}}}
 */
function validateRootConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '根配置必须是 JSON 对象。');
  }
  for (const key of Object.keys(config)) {
    if (!ROOT_CONFIG_KEYS.has(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `根配置包含未知字段：${key}`);
    }
  }
  if (config.schemaVersion !== ROOT_SCHEMA_VERSION) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `不支持的根配置 schemaVersion：${String(config.schemaVersion)}`
    );
  }
  if (typeof config.rootId !== 'string' || !/^root_[A-Za-z0-9-]{6,128}$/.test(config.rootId)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'rootId 格式无效。');
  }
  const displayName = typeof config.displayName === 'string' ? config.displayName.trim() : '';
  if (!displayName || displayName.length > 120) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '根显示名称必须是 1–120 字符。');
  }
  if (hasControlCharacters(displayName)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '根显示名称不能包含控制字符。');
  }
  const workspaceUri = validateWorkspaceFileUri(config.workspaceUri);
  if (!Number.isInteger(config.configRevision) || config.configRevision < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'configRevision 必须是正整数。');
  }
  const partitions = normalizePartitions(config.partitions);
  const slugRules = normalizeSlugRules(config.slugRules);
  return {
    schemaVersion: ROOT_SCHEMA_VERSION,
    rootId: config.rootId,
    displayName,
    workspaceUri,
    configRevision: config.configRevision,
    partitions,
    slugRules
  };
}

/**
 * @param {unknown} partitions
 * @returns {Array<{id: string, name: string, relativePath: string}>}
 */
function normalizePartitions(partitions) {
  const input = partitions === undefined ? DEFAULT_PARTITIONS : partitions;
  if (!Array.isArray(input) || input.length !== PARTITION_IDS.length) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'partitions 必须包含 inbox、projects、archive 三个分区。');
  }
  const byId = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'partition 必须是 JSON 对象。');
    }
    for (const key of Object.keys(item)) {
      if (!['id', 'name', 'relativePath'].includes(key)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, `partition 包含未知字段：${key}`);
      }
    }
    if (typeof item.id !== 'string' || !PARTITION_IDS.includes(item.id)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `未知分区 ID：${String(item.id)}`);
    }
    if (byId.has(item.id)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `分区 ID 重复：${item.id}`);
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 40) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `分区 ${item.id} 的名称必须是 1–40 字符。`);
    }
    const relativePath = requireRelativePath(item.relativePath, `分区 ${item.id} 的路径`);
    if (relativePath.toLowerCase() === '.pm' || relativePath.toLowerCase().startsWith('.pm/')) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '分区路径不能位于 .pm 目录中。');
    }
    byId.set(item.id, { id: item.id, name, relativePath });
  }
  for (const id of PARTITION_IDS) {
    if (!byId.has(id)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `缺少分区：${id}`);
    }
  }
  const list = PARTITION_IDS.map((id) => byId.get(id));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i].relativePath.toLowerCase();
      const b = list[j].relativePath.toLowerCase();
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, '分区路径不能重复或互相嵌套。');
      }
    }
  }
  return list;
}

/**
 * @param {unknown} rules
 * @returns {{pattern: string, maxLength: number, lowercase: boolean}}
 */
function normalizeSlugRules(rules) {
  const input = rules === undefined ? DEFAULT_SLUG_RULES : rules;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slugRules 必须是 JSON 对象。');
  }
  for (const key of Object.keys(input)) {
    if (!['pattern', 'maxLength', 'lowercase'].includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `slugRules 包含未知字段：${key}`);
    }
  }
  const pattern = input.pattern === undefined ? DEFAULT_SLUG_RULES.pattern : input.pattern;
  const maxLength = input.maxLength === undefined ? DEFAULT_SLUG_RULES.maxLength : input.maxLength;
  const lowercase = input.lowercase === undefined ? DEFAULT_SLUG_RULES.lowercase : input.lowercase;
  if (typeof pattern !== 'string' || pattern.length < 3 || pattern.length > 200) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slugRules.pattern 必须是 3–200 字符的字符串。');
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slugRules.pattern 不是合法正则表达式。');
  }
  if (!Number.isInteger(maxLength) || maxLength < 8 || maxLength > 120) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slugRules.maxLength 必须是 8–120 的整数。');
  }
  if (typeof lowercase !== 'boolean') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slugRules.lowercase 必须是布尔值。');
  }
  return { pattern, maxLength, lowercase };
}

/**
 * @param {{rootId: string, displayName: string, workspaceUri: string, partitions?: unknown, slugRules?: unknown, configRevision?: number}} input
 * @returns {object}
 */
function createRootConfig(input) {
  return validateRootConfig({
    schemaVersion: ROOT_SCHEMA_VERSION,
    rootId: input.rootId,
    displayName: input.displayName,
    workspaceUri: input.workspaceUri,
    configRevision: input.configRevision || 1,
    partitions: input.partitions === undefined ? DEFAULT_PARTITIONS : input.partitions,
    slugRules: input.slugRules === undefined ? DEFAULT_SLUG_RULES : input.slugRules
  });
}

/**
 * @param {object} config
 * @param {'inbox'|'projects'|'archive'} id
 */
function partitionById(config, id) {
  const partition = config.partitions.find((item) => item.id === id);
  if (!partition) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `根配置缺少分区：${id}`);
  }
  return partition;
}

/**
 * @param {object} config
 * @param {string} slug
 */
function projectRelativePath(config, slug) {
  const base = partitionById(config, 'projects').relativePath;
  return `${base}/${slug}`;
}

/**
 * @param {object} config
 * @returns {string}
 */
function serializeRootConfig(config) {
  return `${JSON.stringify(validateRootConfig(config), null, 2)}\n`;
}

/**
 * 分区路径必须位于根目录内；这里只做纯路径检查，文件系统层还会做真实路径检查。
 * @param {string} relativePath
 * @returns {string}
 */
function normalizePartitionPath(relativePath) {
  return normalizeRelativePath(relativePath, { label: '分区路径' });
}

module.exports = {
  PARTITION_IDS,
  validateRootConfig,
  createRootConfig,
  normalizePartitions,
  normalizeSlugRules,
  partitionById,
  projectRelativePath,
  serializeRootConfig,
  normalizePartitionPath
};

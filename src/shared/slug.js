'use strict';

const { AppError } = require('./errors');
const { ERROR_CODES, DEFAULT_SLUG_RULES, MAX_DISPLAY_NAME_CHARS } = require('./constants');
const { sha256Hex } = require('./json');

const RESERVED_SLUGS = new Set(['con', 'prn', 'aux', 'nul']);
for (let i = 1; i <= 9; i += 1) {
  RESERVED_SLUGS.add(`com${i}`);
  RESERVED_SLUGS.add(`lpt${i}`);
}

/**
 * 纯中文或 emoji 名称无法转写为 ASCII 时，用显示名称哈希生成稳定 slug，
 * 不把多字节别名写入磁盘路径。
 * @param {string} displayName
 * @returns {string}
 */
function fallbackSlug(displayName) {
  return `project-${sha256Hex(String(displayName || 'project')).slice(0, 8)}`;
}

/**
 * @param {string} displayName
 * @param {{pattern: string, maxLength: number, lowercase: boolean}} [rules]
 * @returns {string}
 */
function slugify(displayName, rules = DEFAULT_SLUG_RULES) {
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '项目显示名称不能为空。');
  }
  if (displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `项目显示名称不能超过 ${MAX_DISPLAY_NAME_CHARS} 字符。`);
  }

  let slug = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) slug = fallbackSlug(displayName);

  const maxLength = Math.max(1, Number(rules.maxLength) || DEFAULT_SLUG_RULES.maxLength);
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  }
  if (!slug) slug = fallbackSlug(displayName).slice(0, maxLength).replace(/-+$/g, '');
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-project`;
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  }
  validateSlug(slug, rules);
  return slug;
}

/**
 * @param {string} slug
 * @param {{pattern: string, maxLength: number, lowercase: boolean}} [rules]
 * @returns {string}
 */
function validateSlug(slug, rules = DEFAULT_SLUG_RULES) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slug 不能为空。');
  }
  if (slug.length > rules.maxLength) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `slug 不能超过 ${rules.maxLength} 字符。`);
  }
  if (rules.lowercase && slug !== slug.toLowerCase()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slug 必须为小写。');
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slug 不能使用 Windows 保留设备名。');
  }
  let pattern;
  try {
    pattern = new RegExp(rules.pattern, 'u');
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'slug 规则中的正则表达式无效。');
  }
  if (!pattern.test(slug)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `slug 不符合规则：${rules.pattern}`);
  }
  return slug;
}

/**
 * 生成候选 slug，用于在冲突时追加 -2、-3。
 * @param {string} base
 * @param {{pattern: string, maxLength: number, lowercase: boolean}} rules
 * @param {number} [maxAttempts]
 * @returns {string[]}
 */
function slugCandidates(base, rules = DEFAULT_SLUG_RULES, maxAttempts = 50) {
  const candidates = [base];
  for (let i = 2; i <= maxAttempts; i += 1) {
    const suffix = `-${i}`;
    candidates.push(`${base.slice(0, Math.max(1, rules.maxLength - suffix.length))}${suffix}`.replace(/-+$/g, ''));
  }
  return candidates;
}

module.exports = {
  slugify,
  validateSlug,
  slugCandidates,
  fallbackSlug
};

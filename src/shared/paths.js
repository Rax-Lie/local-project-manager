'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { AppError } = require('./errors');
const { ERROR_CODES } = require('./constants');

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/;

/**
 * 把用户输入规范为使用 / 分隔的安全相对路径。
 * 拒绝绝对路径、盘符、UNC、`.`/`..`、控制字符和 Windows 保留名。
 * @param {unknown} input
 * @param {{allowEmpty?: boolean, label?: string}} [options]
 * @returns {string}
 */
function normalizeRelativePath(input, options = {}) {
  const label = options.label || '相对路径';
  if (typeof input !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 必须是字符串。`);
  }
  const value = input.replace(/\\/g, '/');
  if (value === '') {
    if (options.allowEmpty) return '';
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 不能为空。`);
  }
  if (value.length > 1024) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 过长（超过 1024 字符）。`);
  }
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('//')) {
    throw new AppError(ERROR_CODES.PATH_ESCAPE, `${label} 不能是绝对路径或 UNC 路径。`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含控制字符。`);
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含空路径段。`);
    }
    if (segment === '.' || segment === '..') {
      throw new AppError(ERROR_CODES.PATH_ESCAPE, `${label} 不能包含 . 或 .. 路径段。`);
    }
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(segment)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 包含 Windows 非法字符。`);
    }
    if (/[. ]$/.test(segment)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 的路径段不能以点或空格结尾。`);
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 使用了 Windows 保留设备名：${segment}`);
    }
    if (Buffer.byteLength(segment, 'utf8') > 255) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${label} 的单个路径段过长。`);
    }
  }
  return segments.join('/');
}

/**
 * @param {string} relativePath
 * @param {string} label
 * @returns {string}
 */
function requireRelativePath(relativePath, label = '相对路径') {
  return normalizeRelativePath(relativePath, { label });
}

/**
 * @param {...string} parts
 * @returns {string}
 */
function joinRelativePath(...parts) {
  return parts
    .filter((part) => part !== '')
    .map((part) => String(part).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isPathInsideOrEqual(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function pathsEqual(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * @param {unknown} uri
 * @param {string} [label]
 * @returns {string}
 */
function fileUriToPath(uri, label = 'URI') {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 必须是非空字符串。`);
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 不是合法 URI。`);
  }
  if (parsed.protocol !== 'file:') {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 必须是 file: URI。`);
  }
  if (parsed.search || parsed.hash) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 不能包含 query 或 fragment。`);
  }
  try {
    return fileURLToPath(parsed);
  } catch {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `${label} 无法转换为本机路径。`);
  }
}

/**
 * @param {string} fsPath
 * @returns {string}
 */
function pathToFileUri(fsPath) {
  return pathToFileURL(path.resolve(fsPath)).href;
}

/**
 * 统一 file URI 的编码形式，便于比较和持久化。
 * @param {string} uri
 * @returns {string}
 */
function normalizeFileUri(uri) {
  return pathToFileUri(fileUriToPath(uri));
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameFileUri(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    return pathsEqual(fileUriToPath(a), fileUriToPath(b));
  } catch {
    return false;
  }
}

/**
 * 目标工作区必须是已保存的 .code-workspace 文件。
 * @param {unknown} uri
 * @returns {string}
 */
function validateWorkspaceFileUri(uri) {
  const fsPath = fileUriToPath(uri, '目标工作区 URI');
  if (path.extname(fsPath).toLowerCase() !== '.code-workspace') {
    throw new AppError(
      ERROR_CODES.INVALID_REQUEST,
      '目标工作区必须是已保存的 .code-workspace 文件。请先保存工作区后重试。'
    );
  }
  return normalizeFileUri(uri);
}

module.exports = {
  normalizeRelativePath,
  requireRelativePath,
  joinRelativePath,
  isPathInsideOrEqual,
  pathsEqual,
  fileUriToPath,
  pathToFileUri,
  normalizeFileUri,
  sameFileUri,
  validateWorkspaceFileUri
};

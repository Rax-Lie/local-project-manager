'use strict';

const { ERROR_CODES, RETRYABLE_CODES } = require('./constants');

/**
 * 所有跨进程边界的业务错误都使用 AppError，调用方按 code 分支。
 */
class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{details?: unknown, retryable?: boolean, operationId?: string, cause?: Error}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details === undefined ? undefined : options.details;
    this.retryable = options.retryable === undefined
      ? RETRYABLE_CODES.has(code)
      : Boolean(options.retryable);
    this.operationId = options.operationId;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    const dto = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (this.operationId) dto.operationId = this.operationId;
    if (this.details !== undefined) dto.details = this.details;
    return dto;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [options]
 * @returns {AppError}
 */
function fail(code, message, options) {
  return new AppError(code, message, options);
}

/**
 * @param {unknown} condition
 * @param {string} message
 * @param {{code?: string, details?: unknown}} [options]
 */
function assert(condition, message, options = {}) {
  if (!condition) {
    throw new AppError(options.code || ERROR_CODES.VALIDATION_FAILED, message, {
      details: options.details
    });
  }
}

/**
 * 将任意异常收敛为 AppError，避免把内部堆栈暴露给扩展宿主。
 * @param {unknown} error
 * @param {string} [fallbackMessage]
 * @returns {AppError}
 */
function normalizeError(error, fallbackMessage = '发生未预期的内部错误') {
  if (error instanceof AppError) return error;

  const code = typeof error?.code === 'string' ? error.code : '';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) {
    return new AppError(ERROR_CODES.PERMISSION_DENIED, `文件系统拒绝访问：${error.message}`, {
      cause: error
    });
  }
  if (['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(code)) {
    return new AppError(ERROR_CODES.CONFLICT, `路径冲突或不存在：${error.message}`, {
      cause: error
    });
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || /database is locked|SQLITE_BUSY/i.test(String(error.message || ''))) {
    return new AppError(ERROR_CODES.DATABASE_BUSY, '数据库正被其他操作占用，请稍后重试。', {
      cause: error
    });
  }
  if (error?.code === 'ERR_SQLITE_ERROR' && /unable to open database|readonly database/i.test(String(error.message))) {
    return new AppError(ERROR_CODES.PERMISSION_DENIED, `数据库无法打开或不可写：${error.message}`, {
      cause: error
    });
  }
  if (code === 'ERR_SQLITE_ERROR' && /unique constraint|constraint failed/i.test(String(error.message))) {
    return new AppError(ERROR_CODES.CONFLICT, '数据库唯一约束冲突。', { cause: error });
  }
  if (error?.name === 'AbortError') {
    return new AppError(ERROR_CODES.CANCELLED, '操作已取消。', { cause: error });
  }

  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return new AppError(ERROR_CODES.INTERNAL_ERROR, message, { cause: error });
}

module.exports = {
  AppError,
  fail,
  assert,
  normalizeError
};

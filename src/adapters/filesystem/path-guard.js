'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError, normalizeError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { normalizeRelativePath, isPathInsideOrEqual } = require('../../shared/paths');

/**
 * 负责相对路径解析、真实路径边界和 symlink/junction 拒绝。
 */
class PathGuard {
  /**
   * @param {string} rootPath
   */
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this._realRoot = null;
  }

  /**
   * @param {string} relativePath
   * @param {{allowEmpty?: boolean}} [options]
   * @returns {string}
   */
  resolve(relativePath, options = {}) {
    const normalized = normalizeRelativePath(relativePath, {
      allowEmpty: options.allowEmpty,
      label: '根内相对路径'
    });
    const absolute = path.resolve(this.rootPath, ...normalized.split('/').filter(Boolean));
    if (!isPathInsideOrEqual(this.rootPath, absolute)) {
      throw new AppError(ERROR_CODES.PATH_ESCAPE, '路径逃逸出管理根。', { details: { relativePath } });
    }
    return absolute;
  }

  /**
   * @returns {Promise<string>}
   */
  async realRoot() {
    if (this._realRoot) return this._realRoot;
    try {
      this._realRoot = await fs.realpath(this.rootPath);
    } catch {
      this._realRoot = this.rootPath;
    }
    return this._realRoot;
  }

  /**
   * 查找最近存在的祖先并检查其真实路径仍在管理根内。
   * @param {string} absolutePath
   */
  async assertRealPathContained(absolutePath) {
    const realRoot = await this.realRoot();
    let current = absolutePath;
    for (;;) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new AppError(ERROR_CODES.PATH_ESCAPE, '路径中包含符号链接或 junction，已拒绝。', {
            details: { path: current }
          });
        }
        const real = await fs.realpath(current);
        if (!isPathInsideOrEqual(realRoot, real)) {
          throw new AppError(ERROR_CODES.PATH_ESCAPE, '真实路径逃逸出管理根。', {
            details: { path: current }
          });
        }
        return;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error.code !== 'ENOENT') throw normalizeError(error);
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<{exists: boolean, type: string, size: number, mtimeMs: number|null, isSymlink: boolean}>}
   */
  async inspect(relativePath) {
    const absolute = this.resolve(relativePath, { allowEmpty: true });
    try {
      const stat = await fs.lstat(absolute);
      let type = 'other';
      if (stat.isSymbolicLink()) type = 'symlink';
      else if (stat.isDirectory()) type = 'directory';
      else if (stat.isFile()) type = 'file';
      return {
        exists: true,
        type,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isSymlink: stat.isSymbolicLink()
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { exists: false, type: 'missing', size: 0, mtimeMs: null, isSymlink: false };
      }
      throw normalizeError(error);
    }
  }
}

module.exports = {
  PathGuard
};

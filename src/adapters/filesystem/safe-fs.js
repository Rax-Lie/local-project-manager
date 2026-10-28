'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError, normalizeError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');
const { normalizeRelativePath } = require('../../shared/paths');
const { PathGuard } = require('./path-guard');

/**
 * 以管理根为边界的文件系统适配器。所有相对路径使用 / 分隔；
 * 写入默认 no-replace，并拒绝 symlink/junction 祖先逃逸。
 */
class SafeFileSystem {
  /**
   * @param {string} rootPath
   */
  constructor(rootPath) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, '管理根必须是绝对路径。');
    }
    this.rootPath = path.resolve(rootPath);
    this.guard = new PathGuard(this.rootPath);
  }

  getRootPath() {
    return this.rootPath;
  }

  /**
   * @param {string} relativePath
   * @param {{allowEmpty?: boolean}} [options]
   * @returns {string}
   */
  resolve(relativePath, options = {}) {
    return this.guard.resolve(relativePath, options);
  }

  /**
   * @returns {Promise<string>}
   */
  async realRoot() {
    return this.guard.realRoot();
  }

  /**
   * @param {string} absolutePath
   */
  async assertRealPathContained(absolutePath) {
    return this.guard.assertRealPathContained(absolutePath);
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<{exists: boolean, type: string, size: number, mtimeMs: number|null, isSymlink: boolean}>}
   */
  async inspect(relativePath) {
    return this.guard.inspect(relativePath);
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<boolean>}
   */
  async exists(relativePath) {
    return (await this.inspect(relativePath)).exists;
  }

  /**
   * 创建单层目录；已存在即冲突。
   * @param {string} relativePath
   */
  async createDirectoryExclusive(relativePath) {
    const absolute = this.resolve(relativePath);
    await this.assertRealPathContained(path.dirname(absolute));
    try {
      await fs.mkdir(absolute, { recursive: false });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new AppError(ERROR_CODES.CONFLICT, `目录已存在：${relativePath}`, {
          details: { relativePath }
        });
      }
      throw normalizeError(error);
    }
  }

  /**
   * 逐层创建目录；允许已存在的目录，但拒绝 symlink 和非目录。
   * @param {string} relativePath
   */
  async createDirectoryTree(relativePath) {
    const normalized = normalizeRelativePath(relativePath, { label: '目录路径' });
    const segments = normalized.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const info = await this.inspect(current);
      if (!info.exists) {
        await this.createDirectoryExclusive(current);
      } else if (info.isSymlink || info.type !== 'directory') {
        throw new AppError(ERROR_CODES.PATH_ESCAPE, `目录路径不是普通目录：${current}`, {
          details: { relativePath: current }
        });
      }
    }
  }

  /**
   * @param {string} relativePath
   * @param {string|Buffer} content
   * @param {{mode?: number}} [options]
   */
  async writeFileExclusive(relativePath, content, options = {}) {
    const absolute = this.resolve(relativePath);
    await this.assertRealPathContained(path.dirname(absolute));
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    let handle = null;
    let created = false;
    try {
      handle = await fs.open(absolute, 'wx', options.mode || 0o644);
      created = true;
      await handle.writeFile(buffer);
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      if (created) await fs.unlink(absolute).catch(() => {});
      if (error.code === 'EEXIST') {
        throw new AppError(ERROR_CODES.CONFLICT, `文件已存在：${relativePath}`, {
          details: { relativePath }
        });
      }
      throw normalizeError(error);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  /**
   * @param {string} relativePath
   * @param {number} [maxBytes]
   * @returns {Promise<Buffer>}
   */
  async readFile(relativePath, maxBytes = 2 * 1024 * 1024) {
    const absolute = this.resolve(relativePath);
    const info = await this.inspect(relativePath);
    if (!info.exists) {
      throw new AppError(ERROR_CODES.ROOT_NOT_INITIALIZED, `文件不存在：${relativePath}`);
    }
    if (info.type !== 'file') {
      throw new AppError(ERROR_CODES.CONFLICT, `不是普通文件：${relativePath}`);
    }
    if (info.size > maxBytes) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `文件超过大小上限：${relativePath}`);
    }
    await this.assertRealPathContained(absolute);
    try {
      return await fs.readFile(absolute);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} relativePath
   * @param {number} [maxBytes]
   * @returns {Promise<string>}
   */
  async readText(relativePath, maxBytes) {
    return (await this.readFile(relativePath, maxBytes)).toString('utf8');
  }

  /**
   * @param {string} relativePath
   * @param {number} [maxBytes]
   * @returns {Promise<unknown>}
   */
  async readJson(relativePath, maxBytes) {
    const text = await this.readText(relativePath, maxBytes);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `JSON 文件损坏：${relativePath}：${error.message}`);
    }
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<Array<{name: string, type: string}>>}
   */
  async listDirectory(relativePath) {
    const absolute = this.resolve(relativePath, { allowEmpty: true });
    await this.assertRealPathContained(absolute);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new AppError(ERROR_CODES.CONFLICT, `目录不存在：${relativePath || '.'}`);
      }
      throw normalizeError(error);
    }
    return entries.map((entry) => {
      let type = 'other';
      if (entry.isSymbolicLink()) type = 'symlink';
      else if (entry.isDirectory()) type = 'directory';
      else if (entry.isFile()) type = 'file';
      return { name: entry.name, type };
    });
  }

  /**
   * 只允许重命名到同卷内不存在的目标，绝不覆盖。
   * @param {string} sourceRelativePath
   * @param {string} targetRelativePath
   */
  async moveNoReplace(sourceRelativePath, targetRelativePath) {
    const source = this.resolve(sourceRelativePath);
    const target = this.resolve(targetRelativePath);
    const sourceInfo = await this.inspect(sourceRelativePath);
    if (!sourceInfo.exists) {
      throw new AppError(ERROR_CODES.CONFLICT, `源路径不存在：${sourceRelativePath}`);
    }
    const targetInfo = await this.inspect(targetRelativePath);
    if (targetInfo.exists) {
      throw new AppError(ERROR_CODES.CONFLICT, `目标路径已存在：${targetRelativePath}`, {
        details: { targetRelativePath }
      });
    }
    await this.assertRealPathContained(source);
    await this.assertRealPathContained(path.dirname(target));
    try {
      await fs.rename(source, target);
    } catch (error) {
      if (error.code === 'EXDEV') {
        throw new AppError(ERROR_CODES.CONFLICT, '源和目标不在同一卷，已停止自动移动。', {
          details: { sourceRelativePath, targetRelativePath }
        });
      }
      throw normalizeError(error);
    }
  }

  /**
   * 只删除空目录；非空目录返回冲突，绝不递归删除。
   * @param {string} relativePath
   */
  async removeEmptyDirectory(relativePath) {
    const absolute = this.resolve(relativePath);
    await this.assertRealPathContained(path.dirname(absolute));
    try {
      await fs.rmdir(absolute);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<void>}
   */
  async removeFile(relativePath) {
    const absolute = this.resolve(relativePath);
    await this.assertRealPathContained(path.dirname(absolute));
    try {
      await fs.unlink(absolute);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<void>}
   */
  async ensureDirectory(relativePath) {
    const absolute = this.resolve(relativePath);
    await fs.mkdir(absolute, { recursive: true });
  }
}

module.exports = {
  SafeFileSystem
};

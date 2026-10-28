'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');

/**
 * 以同目录临时文件替换模板；revision 内容变化时拒绝覆盖并清理临时文件。
 * @param {import('./safe-fs').SafeFileSystem} fsPort
 * @param {string} relativePath
 * @param {string} expectedContent
 * @param {string} nextContent
 */
async function replaceFileAtomically(fsPort, relativePath, expectedContent, nextContent) {
  const initial = await fsPort.inspect(relativePath);
  if (initial.type !== 'file' || initial.isSymlink) {
    throw new AppError(ERROR_CODES.CONFLICT, `模板路径不是普通文件：${relativePath}`);
  }
  if ((await fsPort.readText(relativePath)) !== expectedContent) {
    throw new AppError(ERROR_CODES.CONFLICT, `模板内容已变化，请重新读取：${relativePath}`);
  }
  const tempPath = `${relativePath}.tmp-${randomUUID()}`;
  await fsPort.writeFileExclusive(tempPath, nextContent);
  try {
    if ((await fsPort.readText(relativePath)) !== expectedContent) {
      throw new AppError(ERROR_CODES.CONFLICT, `模板内容已变化，请重新读取：${relativePath}`);
    }
    const source = fsPort.resolve(tempPath);
    const target = fsPort.resolve(relativePath);
    await fsPort.assertRealPathContained(path.dirname(target));
    await fs.rename(source, target);
  } finally {
    const temp = await fsPort.inspect(tempPath);
    if (temp.exists) await fsPort.removeFile(tempPath).catch(() => {});
  }
}

module.exports = {
  replaceFileAtomically
};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { extractMarkdownLinks } = require('../domain/markdown-links');
const { isPathInsideOrEqual } = require('../shared/paths');

const EXTERNAL_SCHEMES = /^(?:https?|mailto|tel|data|ftp):/i;

async function checkMarkdownLinks(markdown, documentPath, workspaceRoots) {
  const roots = await Promise.all(workspaceRoots.map((root) => fs.realpath(root).catch(() => null)));
  const validRoots = roots.filter(Boolean);
  if (validRoots.length === 0) return [issue('NO_WORKSPACE', '没有可检查的本地工作区目录。', '', 0)];
  const realDocument = await fs.realpath(documentPath).catch(() => path.resolve(documentPath));
  if (!validRoots.some((root) => isPathInsideOrEqual(root, realDocument))) {
    return [issue('DOCUMENT_OUTSIDE_WORKSPACE', '当前 Markdown 文件不在已打开的工作区文件夹中。', documentPath, 0)];
  }
  const issues = [];
  for (const link of extractMarkdownLinks(markdown)) {
    const result = await inspectLink(link.destination, path.dirname(realDocument), validRoots);
    if (result) issues.push(issue(result.code, result.message, link.destination, link.start));
  }
  return issues;
}

async function inspectLink(destination, documentDirectory, roots) {
  const value = destination.trim();
  if (!value || value.startsWith('#') || EXTERNAL_SCHEMES.test(value)) return null;
  if (/^file:/i.test(value) || value.startsWith('//') || value.startsWith('\\\\')) {
    return { code: 'ABSOLUTE_LINK', message: '绝对路径或 file URI 不在本地链接检查范围内。' };
  }
  const pathPart = value.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(pathPart); } catch {
    return { code: 'INVALID_URL_ENCODING', message: '链接包含无效的百分号编码。' };
  }
  if (path.isAbsolute(decoded) || path.win32.isAbsolute(decoded) || /^[a-z]:/i.test(decoded)) {
    return { code: 'ABSOLUTE_LINK', message: '绝对路径不在本地链接检查范围内。' };
  }
  const target = path.resolve(documentDirectory, decoded.replace(/\\/g, path.sep));
  if (!roots.some((root) => isPathInsideOrEqual(root, target))) {
    return { code: 'PATH_ESCAPE', message: '相对链接逃逸出所有已打开的工作区文件夹。' };
  }
  let realTarget;
  try { realTarget = await fs.realpath(target); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { code: 'TARGET_MISSING', message: '本地链接目标不存在。' };
    }
    return { code: 'TARGET_UNREADABLE', message: `无法检查本地链接目标：${error.message}` };
  }
  if (!roots.some((root) => isPathInsideOrEqual(root, realTarget))) {
    return { code: 'PATH_ESCAPE', message: '链接目标通过符号链接逃逸出工作区。' };
  }
  try {
    await fs.stat(realTarget);
    return null;
  } catch (error) {
    return { code: 'TARGET_UNREADABLE', message: `无法读取本地链接目标：${error.message}` };
  }
}

function issue(code, message, destination, offset) {
  return { code, message, destination, offset };
}

module.exports = { checkMarkdownLinks, inspectLink };

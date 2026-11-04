'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { sha256Hex } = require('../../shared/json');
const { AppError } = require('../../shared/errors');
const { ERROR_CODES } = require('../../shared/constants');

const MAX_SCAN_ENTRIES = 500;
const PROJECT_MARKERS = Object.freeze([
  'README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'requirements.txt', 'composer.json', '*.code-workspace'
]);
const SOURCE_DIRS = new Set(['src', 'app', 'lib', 'docs', 'source', '工程', '文档']);

async function scanProjectCandidates(scanRootPath) {
  const rootInfo = await fs.lstat(scanRootPath).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '扫描位置必须是本地普通目录，不能是符号链接。');
  }
  const realRoot = await fs.realpath(scanRootPath);
  const entries = await fs.readdir(realRoot, { withFileTypes: true });
  if (entries.length > MAX_SCAN_ENTRIES) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `扫描位置超过 ${MAX_SCAN_ENTRIES} 个直接子项上限，未更新暂存建议。`);
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = await inspectCandidate(realRoot, entry.name);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
}

async function inspectCandidate(scanRoot, displayName) {
  const sourcePath = path.join(scanRoot, displayName);
  const info = await fs.lstat(sourcePath).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return null;
  const realPath = await fs.realpath(sourcePath);
  const relative = path.relative(scanRoot, realPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const contents = await fs.readdir(realPath, { withFileTypes: true });
  const names = new Set(contents.map((item) => item.name.toLowerCase()));
  const markers = PROJECT_MARKERS.filter((marker) => marker.startsWith('*.')
    ? [...names].some((name) => name.endsWith(marker.slice(1)))
    : names.has(marker.toLowerCase()));
  const sourceDirs = contents.filter((item) => item.isDirectory() && SOURCE_DIRS.has(item.name.toLowerCase()))
    .map((item) => item.name);
  if (markers.length === 0 && sourceDirs.length === 0) return null;
  const score = Math.min(95, markers.length * 25 + (sourceDirs.length ? 25 : 0));
  if (score < 50) return null;
  const reasons = [
    ...markers.map((marker) => `发现项目标记：${marker}`),
    ...sourceDirs.map((name) => `包含常见项目目录：${name}`)
  ];
  return {
    candidateId: `cand_${sha256Hex(normalizeIdentity(realPath)).slice(0, 24)}`,
    sourcePath: realPath,
    displayName,
    score,
    reasons
  };
}

function normalizeIdentity(value) {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

module.exports = { MAX_SCAN_ENTRIES, scanProjectCandidates };

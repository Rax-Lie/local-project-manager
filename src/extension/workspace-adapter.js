'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const {
  fileUriToPath,
  isPathInsideOrEqual,
  pathsEqual,
  sameFileUri,
  validateWorkspaceFileUri
} = require('../shared/paths');

/**
 * 只修改“当前打开且与根配置完全匹配”的 .code-workspace。
 * 不直接写 workspace JSON 文件，全部通过 VS Code Workspace API。
 */
class WorkspaceAdapter {
  /**
   * @param {{workspace: object, Uri: object}} host VS Code API（可注入测试替身）
   */
  constructor(host) {
    this.host = host;
  }

  /**
   * @returns {string}
   */
  currentWorkspaceUri() {
    const workspaceFile = this.host.workspace.workspaceFile;
    if (!workspaceFile) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        '当前没有打开 .code-workspace 工作区文件。请先保存并打开目标工作区。'
      );
    }
    if (workspaceFile.scheme !== 'file') {
      throw new AppError(ERROR_CODES.CONFLICT, '只支持本地 file: 工作区。');
    }
    return validateWorkspaceFileUri(workspaceFile.toString());
  }

  /**
   * @param {string} configWorkspaceUri
   * @returns {string}
   */
  assertTargetWorkspace(configWorkspaceUri) {
    const current = this.currentWorkspaceUri();
    if (!sameFileUri(current, configWorkspaceUri)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `当前工作区不是管理根绑定的目标工作区。请先打开：${fileUriToPath(configWorkspaceUri)}`,
        { details: { currentWorkspaceUri: current, expectedWorkspaceUri: configWorkspaceUri } }
      );
    }
    return current;
  }

  /**
   * @returns {Array<{uri: string, fsPath: string, name: string}>}
   */
  folders() {
    return (this.host.workspace.workspaceFolders || []).map((folder) => {
      const uri = folder.uri.toString();
      return { uri, fsPath: fileUriToPath(uri), name: folder.name };
    });
  }

  /**
   * @param {string} uri
   * @returns {boolean}
   */
  contains(uri) {
    return this.folders().some((folder) => sameFileUri(folder.uri, uri));
  }

  /**
   * @param {string} uri
   * @param {string} displayName
   * @param {string} configWorkspaceUri
   * @returns {Promise<{observedPresent: boolean, already: boolean}>}
   */
  async addFolder(uri, displayName, configWorkspaceUri) {
    this.assertTargetWorkspace(configWorkspaceUri);
    const targetPath = fileUriToPath(uri);
    const targetInfo = await fs.lstat(targetPath).catch(() => null);
    if (!targetInfo || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw new AppError(ERROR_CODES.CONFLICT, `项目目录不存在或不是普通目录：${targetPath}`);
    }
    if (!displayName || typeof displayName !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, '工作区显示名称不能为空。');
    }
    if (this.contains(uri)) {
      return { observedPresent: true, already: true };
    }
    for (const folder of this.folders()) {
      if (pathsEqual(folder.fsPath, targetPath)) continue;
      if (isPathInsideOrEqual(folder.fsPath, targetPath)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `目标项目位于已打开的工作区文件夹“${folder.name}”内，请先移除该父文件夹，避免工作区重叠。`
        );
      }
      if (isPathInsideOrEqual(targetPath, folder.fsPath)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `目标项目目录包含已打开的工作区文件夹“${folder.name}”，不能添加为独立工作区项。`
        );
      }
    }
    const folders = this.host.workspace.workspaceFolders || [];
    const item = { uri: this.host.Uri.file(targetPath), name: displayName };
    const updated = this.host.workspace.updateWorkspaceFolders(folders.length, 0, item);
    if (updated === false) {
      throw new AppError(ERROR_CODES.CONFLICT, 'VS Code 拒绝更新工作区文件夹，请检查工作区是否可写。');
    }
    const observed = await this.waitFor(() => this.contains(uri), 3000);
    if (!observed) {
      throw new AppError(ERROR_CODES.CONFLICT, '已请求添加工作区文件夹，但未观察到生效。');
    }
    return { observedPresent: true, already: false };
  }

  /**
   * @param {string} uri
   * @param {string} configWorkspaceUri
   * @returns {Promise<{observedPresent: boolean, already: boolean}>}
   */
  async removeFolder(uri, configWorkspaceUri) {
    this.assertTargetWorkspace(configWorkspaceUri);
    const folders = this.host.workspace.workspaceFolders || [];
    const index = folders.findIndex((folder) => sameFileUri(folder.uri.toString(), uri));
    if (index < 0) return { observedPresent: false, already: true };
    const updated = this.host.workspace.updateWorkspaceFolders(index, 1);
    if (updated === false) {
      throw new AppError(ERROR_CODES.CONFLICT, 'VS Code 拒绝更新工作区文件夹。');
    }
    const removed = await this.waitFor(() => !this.contains(uri), 3000);
    if (!removed) {
      throw new AppError(ERROR_CODES.CONFLICT, '已请求移除工作区文件夹，但未观察到生效。');
    }
    return { observedPresent: false, already: false };
  }

  /**
   * @param {string} oldUri
   * @param {string} newUri
   * @param {string} displayName
   * @param {string} configWorkspaceUri
   */
  async replaceFolder(oldUri, newUri, displayName, configWorkspaceUri) {
    this.assertTargetWorkspace(configWorkspaceUri);
    if (!this.contains(oldUri)) {
      return this.addFolder(newUri, displayName, configWorkspaceUri);
    }
    const folders = this.host.workspace.workspaceFolders || [];
    const index = folders.findIndex((folder) => sameFileUri(folder.uri.toString(), oldUri));
    const updated = this.host.workspace.updateWorkspaceFolders(index, 1, {
      uri: this.host.Uri.file(fileUriToPath(newUri)),
      name: displayName
    });
    if (updated === false) {
      throw new AppError(ERROR_CODES.CONFLICT, 'VS Code 拒绝替换工作区文件夹。');
    }
    const observed = await this.waitFor(() => this.contains(newUri) && !this.contains(oldUri), 3000);
    if (!observed) throw new AppError(ERROR_CODES.CONFLICT, '替换工作区文件夹未生效。');
    return { observedPresent: true, already: false };
  }

  /**
   * @param {() => boolean} predicate
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async waitFor(predicate, timeoutMs) {
    if (predicate()) return true;
    const started = Date.now();
    if (typeof this.host.workspace.onDidChangeWorkspaceFolders === 'function') {
      return new Promise((resolve) => {
        let disposable;
        const timer = setTimeout(() => {
          if (disposable?.dispose) disposable.dispose();
          resolve(predicate());
        }, timeoutMs);
        disposable = this.host.workspace.onDidChangeWorkspaceFolders(() => {
          if (predicate()) {
            clearTimeout(timer);
            if (disposable?.dispose) disposable.dispose();
            resolve(true);
          }
        });
      });
    }
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (predicate()) return true;
    }
    return predicate();
  }
}

module.exports = {
  WorkspaceAdapter
};

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { sameFileUri, normalizeFileUri, pathToFileUri } = require('../shared/paths');
const { validateRootConfig } = require('../domain/root-config');

const STATE_KEY = 'projectManager.roots.v1';

class RootRegistry {
  /**
   * @param {{workspaceState: {get: Function, update: Function}, workspaceFile?: object}} contextLike
   */
  constructor(contextLike) {
    this.context = contextLike;
  }

  /**
   * @returns {string[]}
   */
  list() {
    const value = this.context.workspaceState.get(STATE_KEY, []);
    if (!Array.isArray(value)) return [];
    const result = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      try {
        const normalized = normalizeFileUri(item);
        if (!result.includes(normalized)) result.push(normalized);
      } catch {
        // 丢弃损坏的历史状态
      }
    }
    return result;
  }

  /**
   * @param {string} rootUri
   * @returns {Promise<string[]>}
   */
  async add(rootUri) {
    const normalized = normalizeFileUri(rootUri);
    const roots = this.list();
    if (!roots.includes(normalized)) {
      roots.push(normalized);
      await this.context.workspaceState.update(STATE_KEY, roots);
    }
    return roots;
  }

  /**
   * @param {string} rootUri
   * @returns {Promise<string[]>}
   */
  async remove(rootUri) {
    const normalized = normalizeFileUri(rootUri);
    const roots = this.list().filter((item) => item !== normalized);
    await this.context.workspaceState.update(STATE_KEY, roots);
    return roots;
  }

  /**
   * 从当前工作区文件夹中发现已初始化的管理根，并修复丢失的 workspaceState。
   * @param {object} host VS Code API
   * @returns {Promise<string[]>}
   */
  async discover(host) {
    const workspaceFile = host.workspace.workspaceFile;
    if (!workspaceFile || workspaceFile.scheme !== 'file') return this.list();
    const workspaceUri = workspaceFile.toString();
    const folders = host.workspace.workspaceFolders || [];
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue;
      const configPath = path.join(folder.uri.fsPath, '.pm', 'pm.json');
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        const config = validateRootConfig(JSON.parse(raw));
        if (sameFileUri(config.workspaceUri, workspaceUri)) {
          await this.add(pathToFileUri(folder.uri.fsPath));
        }
      } catch {
        // 不是管理根、配置损坏或属于其他工作区；保持静默，交给 inspect 报告
      }
    }
    return this.list();
  }
}

module.exports = {
  RootRegistry,
  STATE_KEY
};

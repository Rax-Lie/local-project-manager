'use strict';

const path = require('node:path');
const { sameFileUri } = require('../shared/paths');
const { iconForProject, escapeMarkdown } = require('./tree-icons');

const STATUS_LABELS = Object.freeze({
  provisioning: '待同步',
  active: '活动中',
  archiving: '归档中',
  archived: '已归档',
  needs_recovery: '需要恢复'
});

const GROUP_ORDER = Object.freeze([
  { id: 'active', label: '活动项目', statuses: ['active'] },
  { id: 'pending', label: '待同步 / 恢复', statuses: ['provisioning', 'needs_recovery'] },
  { id: 'archiving', label: '归档中', statuses: ['archiving'] },
  { id: 'archived', label: '已归档', statuses: ['archived'] }
]);

/**
 * 管理根 → 状态分组 → 项目 的树视图。
 */
class ProjectTreeProvider {
  /**
   * @param {{vscode: object, cli: object, registry: object, outputChannel?: object}} options
   */
  constructor(options) {
    this.vscode = options.vscode;
    this.cli = options.cli;
    this.registry = options.registry;
    this.outputChannel = options.outputChannel;
    this.roots = [];
    this.globalError = null;
    this.loading = false;
    this._onDidChangeTreeData = new this.vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.refreshPromise = null;
  }

  /**
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
      this._onDidChangeTreeData.fire();
    });
    return this.refreshPromise;
  }

  async doRefresh() {
    this.loading = true;
    this.globalError = null;
    const rootUris = this.registry.list();
    const workspaceFile = this.vscode.workspace.workspaceFile;
    const workspaceUri = workspaceFile ? workspaceFile.toString() : null;
    const next = [];
    for (const rootUri of rootUris) {
      try {
        const inspection = await this.cli.request('root.inspect', { rootUri });
        if (!inspection.initialized) {
          next.push({ rootUri, inspection, error: inspection.issues[0]?.message || '管理根未初始化', projects: [] });
          continue;
        }
        if (inspection.partial) {
          next.push({
            rootUri,
            inspection,
            error: inspection.issues[0]?.message || '管理根文件不完整，需要恢复',
            projects: []
          });
          continue;
        }
        if (workspaceUri && !sameFileUri(inspection.config.workspaceUri, workspaceUri)) {
          next.push({
            rootUri,
            inspection,
            error: `该管理根绑定到其他工作区：${inspection.config.workspaceUri}`,
            projects: []
          });
          continue;
        }
        const page = await this.cli.request('project.search', {
          rootUri,
          rootId: inspection.config.rootId,
          limit: 500
        });
        next.push({ rootUri, inspection, error: null, projects: page.items || [] });
      } catch (error) {
        next.push({ rootUri, inspection: null, error: error.message, projects: [] });
      }
    }
    this.roots = next;
    this.loading = false;
  }

  /**
   * @param {object} [element]
   * @returns {Promise<object[]>}
   */
  async getChildren(element) {
    if (this.loading && this.roots.length === 0) {
      return [this.infoItem('正在加载项目…')];
    }
    if (!element) {
      if (this.roots.length === 0) return [];
      return this.roots.map((root) => this.rootItem(root));
    }
    if (element.kind === 'root') {
      return this.rootChildren(element.data);
    }
    if (element.kind === 'group') {
      return element.data.projects.map((project) => this.projectItem(element.data.root, project));
    }
    return [];
  }

  /**
   * @param {object} rootData
   * @returns {object[]}
   */
  rootChildren(rootData) {
    if (rootData.error) {
      return [this.infoItem(`无法读取：${rootData.error}`)];
    }
    const groups = [];
    for (const group of GROUP_ORDER) {
      const projects = rootData.projects.filter((project) => group.statuses.includes(project.status));
      if (projects.length > 0) {
        groups.push({
          kind: 'group',
          root: rootData,
          id: group.id,
          label: group.label,
          projects
        });
      }
    }
    if (groups.length === 0) {
      groups.push(this.infoItem('尚无项目，使用“新建项目”创建第一个项目。'));
    }
    return groups;
  }

  /**
   * @param {object} rootData
   * @returns {object}
   */
  rootItem(rootData) {
    const label = rootData.inspection?.config?.displayName || path.basename(rootData.inspection?.rootPath || rootData.rootUri);
    return {
      kind: 'root',
      data: rootData,
      label,
      description: rootData.inspection?.rootPath || rootData.rootUri,
      collapsibleState: 1
    };
  }

  /**
   * @param {object} rootData
   * @param {object} project
   * @returns {object}
   */
  projectItem(rootData, project) {
    return {
      kind: 'project',
      project,
      root: rootData,
      label: project.displayName,
      description: `${STATUS_LABELS[project.status] || project.status} · ${project.slug}`,
      collapsibleState: 0
    };
  }

  /**
   * @param {string} label
   * @returns {object}
   */
  infoItem(label) {
    return { kind: 'info', label, collapsibleState: 0 };
  }

  /**
   * @param {object} element
   * @returns {import('vscode').TreeItem}
   */
  getTreeItem(element) {
    if (element.kind === 'root') {
      const item = new this.vscode.TreeItem(element.label, this.vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.description;
      item.iconPath = new this.vscode.ThemeIcon('folder-library');
      item.contextValue = 'pmRoot';
      const inspection = element.data.inspection;
      if (inspection) {
        item.tooltip = [
          `管理根：${inspection.rootPath}`,
          `显示名称：${inspection.config.displayName}`,
          `工作区：${inspection.config.workspaceUri}`,
          `项目数：${element.data.projects.length}`
        ].join('\n');
      }
      return item;
    }
    if (element.kind === 'group') {
      const item = new this.vscode.TreeItem(element.label, this.vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new this.vscode.ThemeIcon('folder');
      item.contextValue = 'pmGroup';
      item.description = String(element.projects.length);
      return item;
    }
    if (element.kind === 'project') {
      const item = new this.vscode.TreeItem(element.label, this.vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.contextValue = 'pmProject';
      item.iconPath = iconForProject(this.vscode, element.project.status);
      item.command = {
        command: 'projectManager.openProject',
        title: '在资源管理器中显示项目',
        arguments: [element]
      };
      item.tooltip = this.projectTooltip(element);
      return item;
    }
    const item = new this.vscode.TreeItem(element.label, this.vscode.TreeItemCollapsibleState.None);
    item.iconPath = new this.vscode.ThemeIcon(element.kind === 'info' ? 'info' : 'warning');
    return item;
  }

  /**
   * @param {object} element
   * @returns {import('vscode').MarkdownString}
   */
  projectTooltip(element) {
    const project = element.project;
    const inspection = element.root.inspection;
    const absolute = inspection ? path.join(inspection.rootPath, ...project.relativePath.split('/')) : project.relativePath;
    const tooltip = new this.vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escapeMarkdown(project.displayName)}**\n\n`);
    tooltip.appendMarkdown(`- 状态：${STATUS_LABELS[project.status] || project.status}\n`);
    tooltip.appendMarkdown(`- slug：\`${project.slug}\`\n`);
    tooltip.appendMarkdown(`- 路径：\`${absolute}\`\n`);
    tooltip.appendMarkdown(`- 模板：\`${project.templateId}\` (r${project.templateRevision})\n`);
    tooltip.appendMarkdown(`- 创建：${project.createdAt}\n`);
    if (project.fieldValues && typeof project.fieldValues === 'object') {
      const entries = Object.entries(project.fieldValues).slice(0, 12);
      if (entries.length > 0) tooltip.appendMarkdown(`\n${entries.map(([key, value]) => `- ${key}：${String(value ?? '')}`).join('\n')}`);
    }
    return tooltip;
  }

  /**
   * @param {object} item
   * @returns {string|null}
   */
  absolutePathOf(item) {
    if (item?.kind !== 'project' || !item.root?.inspection) return null;
    return path.join(item.root.inspection.rootPath, ...item.project.relativePath.split('/'));
  }

  /**
   * @param {string} projectId
   * @returns {object|null}
   */
  findProject(projectId) {
    for (const root of this.roots) {
      const project = root.projects.find((item) => item.projectId === projectId);
      if (project) return { root, project };
    }
    return null;
  }

  /**
   * @param {string} rootUri
   * @returns {object|null}
   */
  findRoot(rootUri) {
    return this.roots.find((root) => sameFileUri(root.rootUri, rootUri)) || null;
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }
}

module.exports = {
  ProjectTreeProvider,
  STATUS_LABELS
};

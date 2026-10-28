'use strict';

const path = require('node:path');
const { ERROR_CODES } = require('../../shared/constants');
const { AppError } = require('../../shared/errors');
const { fileUriToPath, pathToFileUri, sameFileUri, isPathInsideOrEqual } = require('../../shared/paths');
const { confirmPlan, withProgress } = require('./feedback');

/**
 * @param {{vscode: object, cli: object, registry: object, provider: object, outputChannel: object}} deps
 */
async function initializeRootFlow(deps) {
  const { vscode, cli, registry, provider } = deps;
  const config = vscode.workspace.getConfiguration('projectManager');
  const workspaceFile = vscode.workspace.workspaceFile;
  if (!workspaceFile || workspaceFile.scheme !== 'file') {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      '请先打开一个已保存的 .code-workspace 工作区文件，再初始化管理根。'
    );
  }
  const workspaceUri = workspaceFile.toString();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(fileUriToPath(workspaceUri))),
    openLabel: '选择管理根目录'
  });
  if (!picked || picked.length === 0) return;
  const rootUri = picked[0].toString();
  const inspection = await cli.request('root.inspect', { rootUri });

  if (inspection.partial) {
    await registry.add(rootUri);
    await provider.refresh();
  }
  if (inspection.bootstrapOperationId) {
    throw new AppError(
      ERROR_CODES.RECOVERY_REQUIRED,
      '检测到未完成的根初始化，管理根已加入列表，请运行“检查未完成操作”恢复。'
    );
  }

  if (inspection.initialized && inspection.partial) {
    throw new AppError(
      ERROR_CODES.RECOVERY_REQUIRED,
      '该管理根配置存在，但分区或模板目录不完整，请先运行“检查未完成操作”。'
    );
  }
  if (inspection.initialized) {
    if (!sameFileUri(inspection.config.workspaceUri, workspaceUri)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `该管理根已绑定其他工作区：${fileUriToPath(inspection.config.workspaceUri)}`
      );
    }
    await registry.add(rootUri);
    await provider.refresh();
    vscode.window.showInformationMessage(`已连接管理根：${inspection.config.displayName}`);
    return;
  }
  if (inspection.partial) {
    throw new AppError(
      ERROR_CODES.RECOVERY_REQUIRED,
      '该目录存在未完成的初始化痕迹，请先运行“检查未完成操作”。'
    );
  }
  if (!inspection.exists || !inspection.isDirectory) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '所选路径不是可用目录。');
  }
  assertProjectsNotInsideWorkspaceFolder(vscode, inspection.rootPath, config);

  const defaultName = path.basename(fileUriToPath(rootUri)) || '项目管理根';
  const displayName = await vscode.window.showInputBox({
    title: '管理根显示名称',
    prompt: '用于工作区和项目树显示，不会写入项目目录名。',
    value: defaultName,
    validateInput: (value) => {
      if (!value || !value.trim()) return '显示名称不能为空。';
      if (value.trim().length > 120) return '显示名称不能超过 120 字符。';
      return null;
    }
  });
  if (displayName === undefined) return;

  const input = {
    rootUri,
    workspaceUri,
    displayName: displayName.trim(),
    partitions: config.get('partitions'),
    slugRules: config.get('slugRules')
  };
  const plan = await cli.request('root.initialize.plan', input);
  if (!(await confirmPlan(vscode, plan, { title: '确认初始化项目管理根？' }))) return;

  await registry.add(pathToFileUri(inspection.rootPath));
  const result = await withProgress(vscode, '正在初始化管理根…', (token) => cli.request(
    'root.initialize.execute',
    { input, plan },
    { token }
  ));
  await provider.refresh();
  const message = result.warnings?.length > 0
    ? `管理根已就绪（${result.warnings[0].message}）`
    : '管理根初始化完成。';
  vscode.window.showInformationMessage(message);
}

module.exports = {
  initializeRootFlow
};

/**
 * 如果工作区已经打开了 projects 分区的父目录，后续新建项目将无法作为独立
 * 工作区项加入（避免重叠）。在初始化前明确阻止。
 * @param {object} vscode
 * @param {string} rootPath
 * @param {object} config
 */
function assertProjectsNotInsideWorkspaceFolder(vscode, rootPath, config) {
  const partitions = config.get('partitions');
  const projectsPartition = Array.isArray(partitions)
    ? partitions.find((item) => item?.id === 'projects')
    : null;
  const relativePath = projectsPartition?.relativePath || 'projects';
  const projectsBase = path.join(rootPath, ...String(relativePath).split('/'));
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'file') continue;
    if (isPathInsideOrEqual(folder.uri.fsPath, projectsBase)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `工作区已打开“${folder.name}”，它包含 projects 分区。请先移除该工作区文件夹，否则新建项目无法独立加入工作区。`
      );
    }
  }
}

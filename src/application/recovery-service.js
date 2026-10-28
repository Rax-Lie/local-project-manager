'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES } = require('../shared/constants');
const { isPlainObject, sha256Hex } = require('../shared/json');
const { normalizeFileUri } = require('../shared/paths');
const { nowIso } = require('../shared/ids');
const { withRootContext } = require('./context');
const { assertRootId } = require('./template-service');
const { inspectRoot } = require('./root-inspect');
const { recoverRootBootstrap } = require('./root-bootstrap-recovery');
/**
 * @param {unknown} payload
 * @returns {Promise<object>}
 */
async function inspectRecovery(payload) {
  if (!isPlainObject(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, '恢复检查输入必须是对象。');
  }
  const allowed = ['rootUri', 'rootId', 'operationId', 'apply'];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `恢复检查包含未知字段：${key}`);
    }
  }
  const rootUri = normalizeFileUri(payload.rootUri);
  const apply = payload.apply === true;
  const bootstrapRecovery = await recoverRootBootstrap({
    rootUri, rootId: payload.rootId, operationId: payload.operationId, apply
  });
  if (bootstrapRecovery) return bootstrapRecovery;
  const inspection = await inspectRoot({ rootUri });
  if (!inspection.initialized || !inspection.database.exists) {
    return {
      rootUri,
      rootInitialized: false,
      apply,
      operations: [],
      issues: inspection.issues,
      summary: { incomplete: 0, needsRecovery: 0 }
    };
  }
  return withRootContext(rootUri, async (context) => {
    assertRootId(context.config.rootId, payload.rootId);
    let operations;
    if (payload.operationId !== undefined) {
      const one = await context.journal.get(payload.operationId);
      if (!one) throw new AppError(ERROR_CODES.VALIDATION_FAILED, '找不到指定操作。');
      operations = [one];
    } else {
      operations = await context.journal.listIncomplete(context.config.rootId);
    }
    const reports = [];
    for (const operation of operations) {
      reports.push(await buildReport(context, operation, apply));
    }
    return {
      rootUri,
      rootInitialized: true,
      apply,
      operations: reports,
      issues: inspection.issues,
      summary: {
        incomplete: reports.filter((item) => item.state !== 'completed').length,
        needsRecovery: reports.filter((item) => item.state === 'needs_recovery').length,
        recovered: reports.filter((item) => item.recovered).length
      }
    };
  });
}
/**
 * @param {object} context
 * @param {object} operation
 * @param {boolean} apply
 * @returns {Promise<object>}
 */
async function buildReport(context, operation, apply) {
  const project = operation.projectId ? await context.repo.getById(operation.projectId) : null;
  const report = {
    operationId: operation.operationId,
    kind: operation.kind,
    state: operation.state,
    projectId: operation.projectId || null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    sourceRelativePath: operation.sourceRelativePath || null,
    targetRelativePath: operation.targetRelativePath || null,
    project: project ? {
      projectId: project.projectId,
      displayName: project.displayName,
      slug: project.slug,
      relativePath: project.relativePath,
      status: project.status
    } : null,
    checks: [],
    action: 'none',
    recovered: false,
    message: ''
  };
  if (operation.kind === 'project.create') {
    await reportProjectCreate(context, operation, project, report, apply);
  } else if (operation.kind === 'project.file.write') {
    await reportFileWrite(context, operation, report, apply);
  } else if (operation.kind === 'project.archive') {
    await reportArchive(context, operation, project, report, apply);
  } else if (operation.kind === 'root.initialize') {
    await reportRootInit(context, operation, report, apply);
  } else {
    report.action = 'manual';
    report.message = `未知操作类型：${operation.kind}`;
  }
  return report;
}

/**
 * @param {object} context
 * @param {object} operation
 * @param {object|null} project
 * @param {object} report
 * @param {boolean} apply
 */
async function reportProjectCreate(context, operation, project, report, apply) {
  report.checks.push(check('project_record', Boolean(project), project ? '项目记录存在。' : '项目记录缺失。'));
  if (project) {
    const dir = await context.fs.inspect(project.relativePath);
    report.checks.push(check('project_directory', dir.exists && dir.type === 'directory',
      dir.exists ? '项目目录存在。' : '项目目录缺失。'));
    const snapshot = await context.fs.inspect(`${project.relativePath}/.pm-project.json`);
    report.checks.push(check('snapshot', snapshot.exists, snapshot.exists ? '元数据快照存在。' : '元数据快照缺失。'));
  }
  if (operation.state === 'awaiting_workspace') {
    report.action = 'workspace_sync';
    report.message = '项目目录和记录已就绪，可运行“完成待同步项目”。';
    return;
  }
  if (operation.state === 'applying' && project && report.checks.every((item) => item.ok)) {
    if (apply) {
      await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['recovered_by_operation_recover']
      });
      report.recovered = true;
      report.state = 'awaiting_workspace';
      report.action = 'workspace_sync';
      report.message = '已安全推进到等待工作区同步状态。';
    } else {
      report.action = 'resume';
      report.message = '磁盘和数据库一致，可安全推进到等待工作区同步。';
    }
    return;
  }
  if (operation.state !== 'completed') {
    report.action = 'manual';
    report.message = '磁盘、数据库或快照不一致，需要人工检查，未自动删除任何内容。';
  }
}

/**
 * @param {object} context
 * @param {object} operation
 * @param {object} report
 * @param {boolean} apply
 */
async function reportFileWrite(context, operation, report, apply) {
  const target = operation.targetRelativePath;
  const info = target ? await context.fs.inspect(target) : { exists: false };
  report.checks.push(check('target_file', info.exists, target
    ? (info.exists ? `目标文件存在：${target}` : `目标文件缺失：${target}`)
    : '操作缺少目标路径。'));
  if (info.exists && target) {
    const expectedHash = operation.payload?.plan?.details?.contentHash;
    const content = await context.fs.readFile(target);
    const actualHash = sha256Hex(content.toString('utf8'));
    const matches = Boolean(expectedHash) && expectedHash === actualHash;
    report.checks.push(check('content_hash', matches, matches ? '文件内容与计划一致。' : '文件内容与计划不一致。'));
    if (matches && operation.state === 'applying') {
      if (apply) {
        await context.journal.transition(operation.operationId, 'applying', 'completed', {
          completedSteps: ['recovered_file_write']
        });
        report.recovered = true;
        report.state = 'completed';
        report.action = 'none';
        report.message = '文件内容与计划一致，已补记为完成。';
      } else {
        report.action = 'resume';
        report.message = '文件已写入且内容一致，可补记为完成。';
      }
      return;
    }
  }
  if (operation.state !== 'completed') {
    report.action = 'manual';
    report.message = '文件状态无法确认，需要人工检查，未自动覆盖。';
  }
}

/**
 * @param {object} context
 * @param {object} operation
 * @param {object|null} project
 * @param {object} report
 * @param {boolean} apply
 */
async function reportArchive(context, operation, project, report, apply) {
  const source = operation.sourceRelativePath;
  const target = operation.targetRelativePath;
  const sourceInfo = source ? await context.fs.inspect(source) : { exists: false };
  const targetInfo = target ? await context.fs.inspect(target) : { exists: false };
  report.checks.push(check('source_directory', sourceInfo.exists, source
    ? (sourceInfo.exists ? '源目录仍存在。' : '源目录已移动。') : '缺少源路径。'));
  report.checks.push(check('target_directory', targetInfo.exists, target
    ? (targetInfo.exists ? '归档目录存在。' : '归档目录缺失。') : '缺少目标路径。'));
  if (operation.state === 'awaiting_workspace') {
    report.action = 'workspace_sync';
    report.message = '目录已移动，可移除工作区旧文件夹以完成归档。';
    return;
  }
  if (operation.state === 'applying' && !sourceInfo.exists && targetInfo.exists && project
    && project.relativePath === target) {
    if (apply) {
      await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['recovered_archive_move']
      });
      report.recovered = true;
      report.state = 'awaiting_workspace';
      report.action = 'workspace_sync';
      report.message = '目录已移动且台账已更新，等待移除工作区旧文件夹。';
    } else {
      report.action = 'resume';
      report.message = '目录已移动且台账已更新，可安全推进到等待工作区移除。';
    }
    return;
  }
  if (operation.state === 'applying' && !sourceInfo.exists && targetInfo.exists && project
    && project.relativePath === source) {
    if (apply) {
      const updated = { ...project, relativePath: target, status: 'archiving', updatedAt: nowIso() };
      await context.repo.update(updated, project.updatedAt);
      await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
        completedSteps: ['recovered_archive_move']
      });
      report.recovered = true;
      report.state = 'awaiting_workspace';
      report.action = 'workspace_sync';
      report.message = '已补记目录移动，等待移除工作区旧文件夹。';
    } else {
      report.action = 'resume';
      report.message = '移动已完成但台账未更新，可安全补记。';
    }
    return;
  }
  if (operation.state !== 'completed') {
    report.action = 'manual';
    report.message = '源、目标或台账状态不一致，需要人工检查，未自动移动或删除。';
  }
}

/**
 * @param {object} context
 * @param {object} operation
 * @param {object} report
 * @param {boolean} apply
 */
async function reportRootInit(context, operation, report, apply) {
  const configExists = (await context.fs.inspect('.pm/pm.json')).exists;
  const dbCheck = context.db.quickCheck();
  report.checks.push(check('config', configExists, configExists ? '根配置存在。' : '根配置缺失。'));
  report.checks.push(check('database', dbCheck.ok, dbCheck.ok ? '数据库完整性检查通过。' : '数据库完整性检查失败。'));
  for (const partition of context.config.partitions) {
    const info = await context.fs.inspect(partition.relativePath);
    report.checks.push(check(`partition:${partition.id}`, info.exists && info.type === 'directory',
      `分区 ${partition.relativePath} ${info.exists ? '存在' : '缺失'}。`));
  }
  if (operation.state === 'applying' && report.checks.every((item) => item.ok)) {
    if (apply) {
      await context.journal.transition(operation.operationId, 'applying', 'completed', {
        completedSteps: ['recovered_root_initialization']
      });
      report.recovered = true;
      report.state = 'completed';
      report.message = '初始化文件与数据库一致，已补记为完成。';
    } else {
      report.action = 'resume';
      report.message = '初始化文件与数据库一致，可补记为完成。';
    }
    return;
  }
  if (operation.state !== 'completed' && report.checks.some((item) => !item.ok)) {
    report.action = 'manual';
    report.message = '初始化不完整，需要人工检查，未自动覆盖用户内容。';
  }
}
function check(name, ok, message) {
  return { name, ok, message };
}
module.exports = {
  inspectRecovery
};

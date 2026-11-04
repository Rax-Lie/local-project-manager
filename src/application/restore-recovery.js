'use strict';

const { nowIso } = require('../shared/ids');

async function reportRestore(context, operation, project, report, apply) {
  const source = operation.sourceRelativePath;
  const target = operation.targetRelativePath;
  const sourceInfo = source ? await context.fs.inspect(source) : { exists: false };
  const targetInfo = target ? await context.fs.inspect(target) : { exists: false };
  report.checks.push({ name: 'archive_directory', ok: sourceInfo.exists, message: sourceInfo.exists ? '归档目录仍存在。' : '归档目录已移动。' });
  report.checks.push({ name: 'project_directory', ok: targetInfo.exists, message: targetInfo.exists ? '项目分区目录存在。' : '项目分区目录缺失。' });
  if (operation.state === 'awaiting_workspace') {
    report.action = 'workspace_sync';
    report.message = '项目目录已恢复，可将项目分区重新加入工作区。';
    return;
  }
  const atSource = project?.relativePath === source && project.status === 'archived';
  const atTarget = project?.relativePath === target && project.status === 'archived';
  if (!['applying', 'needs_recovery'].includes(operation.state)) {
    report.action = 'manual';
    report.message = '恢复日志状态无法自动推进。';
    return;
  }
  if (sourceInfo.exists && !targetInfo.exists && atSource) {
    if (!apply) {
      report.action = 'resume';
      report.message = '归档源和项目台账一致，可安全恢复目录。';
      return;
    }
    if (operation.state === 'needs_recovery') await context.journal.transition(operation.operationId, 'needs_recovery', 'applying');
    const parent = target.split('/').slice(0, -1).join('/');
    await context.fs.createDirectoryTree(parent);
    await context.fs.moveNoReplace(source, target);
    await context.repo.update({ ...project, relativePath: target, updatedAt: nowIso() }, project.updatedAt);
  } else if (!sourceInfo.exists && targetInfo.exists && (atTarget || atSource)) {
    if (!apply) {
      report.action = 'resume';
      report.message = '项目目录已恢复且台账一致，可推进到工作区同步。';
      return;
    }
    if (operation.state === 'needs_recovery') await context.journal.transition(operation.operationId, 'needs_recovery', 'applying');
    if (atSource) {
      await context.repo.update({ ...project, relativePath: target, updatedAt: nowIso() }, project.updatedAt);
    }
  } else {
    report.action = 'manual';
    report.message = '归档源、目标或台账状态冲突，未移动或覆盖任何内容。';
    return;
  }
  await context.journal.transition(operation.operationId, 'applying', 'awaiting_workspace', {
    completedSteps: ['recovered_restore_move', 'database_updated']
  });
  report.state = 'awaiting_workspace';
  report.recovered = true;
  report.action = 'workspace_sync';
  report.message = '已安全恢复项目目录，等待工作区同步。';
}

module.exports = { reportRestore };

'use strict';

const { createProjectFlow } = require('../ui/project-flow');
const { pickRoot } = require('../ui/feedback');

async function stagingSuggestionsFlow(deps) {
  const { vscode, cli, provider } = deps;
  if (provider.roots.length === 0) await provider.refresh();
  const root = await pickRoot(vscode, provider, '选择用于创建项目工作文件夹的管理根');
  if (!root) return;
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '扫描一级子目录'
  });
  if (!selected?.[0]) return;
  const scanRootUri = selected[0].toString();
  const scan = await cli.request('project.stage.scan', {
    rootUri: root.rootUri,
    rootId: root.inspection.config.rootId,
    scanRootUri
  });
  if (scan.candidates.length === 0) {
    vscode.window.showInformationMessage('没有发现新的项目候选目录。被忽略或已处理的候选不会重复显示。');
    return;
  }
  const picked = await vscode.window.showQuickPick(scan.candidates.map((candidate) => ({
    label: candidate.displayName,
    description: `建议分 ${candidate.score} · ${candidate.reasons.length} 项项目特征`,
    detail: `${candidate.sourcePath}\n${candidate.reasons.join('；')}`,
    candidate
  })), { placeHolder: '选择候选目录；这里只读取目录名和直接子项名称' });
  if (!picked) return;
  const action = await vscode.window.showQuickPick([
    { label: '新建独立项目工作文件夹', value: 'create' },
    { label: '忽略此候选', value: 'ignore' }
  ], { placeHolder: `${picked.candidate.displayName}：选择后续处理` });
  if (!action) return;
  if (action.value === 'ignore') {
    await decide(cli, root, picked.candidate, 'ignored');
    vscode.window.showInformationMessage(`已忽略候选“${picked.candidate.displayName}”。`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `将根据“${picked.candidate.displayName}”新建项目工作文件夹？`,
    { modal: true, detail: `原目录保持不变，也不会复制或导入其中的文件。来源：${picked.candidate.sourcePath}` },
    '继续新建'
  );
  if (confirmed !== '继续新建') return;
  const created = await createProjectFlow(deps, { root, displayName: picked.candidate.displayName });
  if (!created?.project?.projectId) return;
  await decide(cli, root, picked.candidate, 'accepted', created.project.projectId);
  vscode.window.showInformationMessage(`已为候选“${picked.candidate.displayName}”新建独立项目工作文件夹。`);
}

async function decide(cli, root, candidate, decision, projectId) {
  return cli.request('project.stage.decide', {
    rootUri: root.rootUri,
    rootId: root.inspection.config.rootId,
    candidateId: candidate.candidateId,
    decision,
    ...(projectId ? { projectId } : {})
  });
}

module.exports = { stagingSuggestionsFlow };

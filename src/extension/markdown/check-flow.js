'use strict';

const { checkMarkdownLinks } = require('../markdown-link-checker');

async function checkMarkdownLinksFlow(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file' || editor.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('请先打开本地 Markdown 文件，再运行链接检查。');
    return;
  }
  const roots = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  const issues = await checkMarkdownLinks(editor.document.getText(), editor.document.uri.fsPath, roots);
  if (issues.length === 0) {
    vscode.window.showInformationMessage('Markdown 本地链接检查通过。');
    return;
  }
  const selected = await vscode.window.showQuickPick(issues.map((item) => {
    const position = editor.document.positionAt(item.offset);
    return {
      label: `${item.code} · 第 ${position.line + 1} 行`,
      description: item.destination,
      detail: item.message,
      item,
      position
    };
  }), { placeHolder: `发现 ${issues.length} 个需要检查的本地链接` });
  if (selected) {
    const range = new vscode.Range(selected.position, selected.position);
    editor.selection = new vscode.Selection(selected.position, selected.position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

module.exports = { checkMarkdownLinksFlow };

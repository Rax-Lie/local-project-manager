'use strict';

/**
 * @param {object} vscode
 * @param {string} status
 */
function iconForProject(vscode, status) {
  switch (status) {
    case 'active':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'provisioning':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.yellow'));
    case 'needs_recovery':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
    case 'archiving':
      return new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.yellow'));
    case 'archived':
      return new vscode.ThemeIcon('archive');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

module.exports = {
  iconForProject,
  escapeMarkdown
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeEventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {
    this.listeners.clear();
  }
}

class FakeTreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class FakeMarkdownString {
  constructor() {
    this.value = '';
  }

  appendMarkdown(value) {
    this.value += value;
    return this;
  }
}

function makeFakeVscode() {
  const commands = new Map();
  const config = {
    nodePath: '',
    requestTimeoutMs: 120000,
    maxSearchResults: 100,
    partitions: [],
    slugRules: {},
    get(key) { return this[key]; }
  };
  const emitter = new FakeEventEmitter();
  const treeView = {
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    dispose() {}
  };
  const vscode = {
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    MarkdownString: FakeMarkdownString,
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: {
      file: (fsPath) => ({
        scheme: 'file',
        fsPath,
        toString: () => pathToFileURL(fsPath).href
      })
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      async executeCommand() {}
    },
    workspace: {
      workspaceFile: undefined,
      workspaceFolders: [],
      getConfiguration: () => config,
      createFileSystemWatcher: () => ({
        onDidCreate() {},
        onDidChange() {},
        onDidDelete() {},
        dispose() {}
      }),
      onDidChangeWorkspaceFolders: emitter.event,
      onDidChangeConfiguration: emitter.event
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createTreeView: () => treeView,
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        name: '',
        command: '',
        show() {},
        dispose() {}
      }),
      withProgress: async (options, task) => task({ report() {} }, {
        onCancellationRequested: () => ({ dispose() {} })
      }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined
    }
  };
  return { vscode, commands, treeView };
}

test('扩展激活时注册全部清单命令且不启动 CLI', async () => {
  const { vscode, commands, treeView } = makeFakeVscode();
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const manifest = require('../../package.json');
  const context = {
    extensionPath: path.resolve(__dirname, '../..'),
    subscriptions: [],
    workspaceState: {
      value: undefined,
      get(key, fallback) { return this.value === undefined ? fallback : this.value; },
      async update(key, value) { this.value = value; }
    }
  };
  try {
    const extensionPath = require.resolve('../../src/extension/extension.js');
    delete require.cache[extensionPath];
    const extension = require(extensionPath);
    extension.activate(context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const command of manifest.contributes.commands) {
      assert.equal(typeof commands.get(command.command), 'function', command.command);
    }
    assert.equal(treeView.visible, true);
    extension.deactivate();
  } finally {
    Module._load = originalLoad;
    for (const subscription of context.subscriptions) {
      try { subscription.dispose(); } catch { /* ignore */ }
    }
  }
});

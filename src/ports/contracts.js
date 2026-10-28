'use strict';

/**
 * 端口契约。实现由 adapters 提供，application 只依赖这些方法。
 * @typedef {object} ProjectRepository
 * @property {(id: string) => Promise<object|null>} getById
 * @property {(rootId: string, slug: string) => Promise<object|null>} getBySlug
 * @property {(query: object) => Promise<{items: object[], nextCursor?: string}>} search
 * @property {(record: object) => Promise<void>} insert
 * @property {(record: object, expectedUpdatedAt: string) => Promise<void>} update
 * @property {(rootId: string) => Promise<object[]>} listForRoot
 *
 * @typedef {object} OperationJournal
 * @property {(record: object) => Promise<void>} begin
 * @property {(id: string) => Promise<object|null>} get
 * @property {(rootId: string) => Promise<object[]>} listIncomplete
 * @property {(id: string, expectedState: string, nextState: string, patch?: object) => Promise<object>} transition
 *
 * @typedef {object} SafeFileSystemPort
 * @property {(relativePath: string) => Promise<object>} inspect
 * @property {(relativePath: string) => Promise<void>} createDirectoryExclusive
 * @property {(relativePath: string, content: string|Buffer) => Promise<void>} writeFileExclusive
 * @property {(source: string, target: string) => Promise<void>} moveNoReplace
 * @property {(relativePath: string) => Promise<void>} removeEmptyDirectory
 *
 * @typedef {object} WorkspaceAdapter
 * @property {(uri: string) => boolean} contains
 * @property {(uri: string, displayName: string) => Promise<void>} addFolder
 * @property {(uri: string) => Promise<void>} removeFolder
 * @property {(oldUri: string, newUri: string, displayName: string) => Promise<void>} replaceFolder
 */

const PORT_METHODS = Object.freeze({
  ProjectRepository: ['getById', 'getBySlug', 'search', 'insert', 'update', 'listForRoot'],
  OperationJournal: ['begin', 'get', 'listIncomplete', 'transition'],
  SafeFileSystem: ['inspect', 'createDirectoryExclusive', 'writeFileExclusive', 'moveNoReplace', 'removeEmptyDirectory'],
  WorkspaceAdapter: ['contains', 'addFolder', 'removeFolder', 'replaceFolder']
});

/**
 * 组合根处快速发现端口实现缺方法的问题。
 * @param {object} target
 * @param {keyof PORT_METHODS} portName
 */
function assertImplements(target, portName) {
  const methods = PORT_METHODS[portName];
  const missing = methods.filter((method) => typeof target?.[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${portName} 缺少方法：${missing.join(', ')}`);
  }
}

module.exports = {
  PORT_METHODS,
  assertImplements
};

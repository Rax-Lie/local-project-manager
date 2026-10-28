'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CliClient } = require('../../src/extension/cli-client');

const EXTENSION_PATH = path.resolve(__dirname, '../..');
const HEALTH = {
  protocolVersion: 1,
  ok: true,
  data: {
    protocolVersion: 1,
    supportedProtocolVersions: [1],
    cliVersion: '0.1.0',
    nodeVersion: '22.22.1',
    platform: 'win32',
    arch: 'x64',
    sqlite: { available: true, version: '3.49.1', error: null }
  }
};

/**
 * @param {(context: {child: EventEmitter, text: string, command: string}) => void} handler
 */
function makeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.emit('close', null);
    };
    child.stdin.end = (text) => {
      calls.push({ command, args, options, text });
      try {
        handler({ child, text, command, args, options });
      } catch (error) {
        child.emit('error', error);
      }
    };
    return child;
  };
  return { spawnImpl, calls };
}

function respond(child, response, options = {}) {
  setTimeout(() => {
    if (child.killed) return;
    child.stdout.emit('data', typeof response === 'string' ? response : JSON.stringify(response));
    child.emit('close', options.status ?? 0);
  }, options.delay ?? 0);
}

function parseRequest(text) {
  return JSON.parse(text);
}

function successFor(request) {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    ok: true,
    data: { operation: request.operation, echo: request.payload }
  };
}

test('解析运行时并通过协议返回数据', async () => {
  const { spawnImpl, calls } = makeSpawn(({ child, text }) => {
    const request = parseRequest(text);
    respond(child, request.operation === 'system.health'
      ? { ...HEALTH, requestId: request.requestId }
      : successFor(request));
  });
  const client = new CliClient({
    extensionPath: EXTENSION_PATH,
    spawnImpl,
    getConfig: () => ({ nodePath: 'C:\\Node\\node.exe', requestTimeoutMs: 30000 })
  });
  const data = await client.request('project.search', { rootUri: 'file:///C:/root' });
  assert.equal(data.operation, 'project.search');
  assert.equal(calls[0].command, 'C:\\Node\\node.exe');
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[1].command, 'C:\\Node\\node.exe');
});

test('CLI 错误响应映射为 AppError 并按 code 分支', async () => {
  const { spawnImpl } = makeSpawn(({ child, text }) => {
    const request = parseRequest(text);
    if (request.operation === 'system.health') {
      respond(child, { ...HEALTH, requestId: request.requestId });
      return;
    }
    respond(child, {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'RECOVERY_REQUIRED',
        message: '需要恢复',
        retryable: false,
        operationId: 'op_123',
        details: { state: 'needs_recovery' }
      }
    });
  });
  const client = new CliClient({ extensionPath: EXTENSION_PATH, spawnImpl, getConfig: () => ({}) });
  await assert.rejects(
    client.request('project.create.execute', {}),
    (error) => error.code === 'RECOVERY_REQUIRED'
      && error.operationId === 'op_123'
      && error.details.state === 'needs_recovery'
  );
});

test('运行时 Node 过低或 SQLite 不可用时拒绝', async () => {
  for (const health of [
    { ...HEALTH, data: { ...HEALTH.data, nodeVersion: '20.18.0' } },
    { ...HEALTH, data: { ...HEALTH.data, sqlite: { available: false, version: null, error: 'missing' } } }
  ]) {
    const { spawnImpl } = makeSpawn(({ child, text }) => {
      const request = parseRequest(text);
      respond(child, { ...health, requestId: request.requestId });
    });
    const client = new CliClient({ extensionPath: EXTENSION_PATH, spawnImpl, getConfig: () => ({}) });
    await assert.rejects(
      client.request('system.health', {}),
      (error) => error.code === 'RUNTIME_UNAVAILABLE'
    );
  }
});

test('响应信封、requestId、行数和非零退出码被校验', async () => {
  const cases = [
    { response: '{"protocolVersion":1,"requestId":"wrong","ok":true,"data":{}}', code: 'INTERNAL_ERROR' },
    { response: '{"protocolVersion":9,"requestId":"ID","ok":true,"data":{}}', code: 'INTERNAL_ERROR' },
    { response: '{"protocolVersion":1,"requestId":"ID","ok":true,"data":{}}\n{"x":1}', code: 'INTERNAL_ERROR' },
    { response: 'not-json', code: 'INTERNAL_ERROR' }
  ];
  for (const item of cases) {
    const { spawnImpl } = makeSpawn(({ child, text }) => {
      const request = parseRequest(text);
      if (request.operation === 'system.health') {
        respond(child, { ...HEALTH, requestId: request.requestId });
        return;
      }
      const response = item.response
        .replaceAll('"ID"', JSON.stringify(request.requestId))
        .replace('"requestId":"ID"', `"requestId":${JSON.stringify(request.requestId)}`);
      respond(child, response);
    });
    const client = new CliClient({ extensionPath: EXTENSION_PATH, spawnImpl, getConfig: () => ({}) });
    await assert.rejects(client.request('project.search', {}), (error) => error.code === item.code);
  }
});

test('超时和取消都会终止子进程', async () => {
  const timeoutSpawn = makeSpawn(({ child, text }) => {
    const request = parseRequest(text);
    if (request.operation === 'system.health') {
      respond(child, { ...HEALTH, requestId: request.requestId });
    }
  });
  const timeoutClient = new CliClient({
    extensionPath: EXTENSION_PATH,
    spawnImpl: timeoutSpawn.spawnImpl,
    getConfig: () => ({})
  });
  await assert.rejects(
    timeoutClient.request('project.search', {}, { timeoutMs: 30 }),
    (error) => error.code === 'RUNTIME_UNAVAILABLE' && /未响应/.test(error.message)
  );

  let cancel = null;
  const cancelSpawn = makeSpawn(({ child, text }) => {
    const request = parseRequest(text);
    if (request.operation === 'system.health') {
      respond(child, { ...HEALTH, requestId: request.requestId });
      return;
    }
    setTimeout(() => cancel?.(), 10);
  });
  const cancelClient = new CliClient({
    extensionPath: EXTENSION_PATH,
    spawnImpl: cancelSpawn.spawnImpl,
    getConfig: () => ({})
  });
  const token = {
    onCancellationRequested(callback) {
      cancel = callback;
      return { dispose() {} };
    }
  };
  await assert.rejects(
    cancelClient.request('project.search', {}, { token }),
    (error) => error.code === 'CANCELLED'
  );
});

test('spawn 失败返回 RUNTIME_UNAVAILABLE', async () => {
  const client = new CliClient({
    extensionPath: EXTENSION_PATH,
    spawnImpl: () => { throw new Error('ENOENT'); },
    getConfig: () => ({})
  });
  await assert.rejects(
    client.request('system.health', {}),
    (error) => error.code === 'RUNTIME_UNAVAILABLE' && Array.isArray(error.details.attempts)
  );
});

test('parseResponse 拒绝非零退出码的成功响应，并接受零退出码错误响应', () => {
  const client = new CliClient({ extensionPath: EXTENSION_PATH, getConfig: () => ({}) });
  assert.throws(() => client.parseResponse({
    status: 1,
    stdout: JSON.stringify({ protocolVersion: 1, requestId: 'r', ok: true, data: {} }),
    stderr: ''
  }, 'r'), /退出码/);
  assert.throws(() => client.parseResponse({
    status: 0,
    stdout: JSON.stringify({ protocolVersion: 1, requestId: 'r', ok: false, error: { code: 'CONFLICT', message: 'x' } }),
    stderr: ''
  }, 'r'), (error) => error.code === 'CONFLICT');
});

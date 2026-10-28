'use strict';

const { AppError, normalizeError } = require('../shared/errors');
const {
  ERROR_CODES,
  MAX_RESPONSE_BYTES,
  MAX_STDERR_BYTES,
  SUPPORTED_PROTOCOL_VERSIONS
} = require('../shared/constants');
const { isPlainObject } = require('../shared/json');

/**
 * 启动 CLI 子进程并收集单条响应。只使用异步 spawn。
 * @param {{spawnImpl: Function, cliPath: string, cwd: string, runtime: object, requestText: string, timeoutMs: number, token?: object}} options
 * @returns {Promise<{status: number|null, stdout: string, stderr: string}>}
 */
function runProcess(options) {
  const { spawnImpl, cliPath, cwd, runtime, requestText, timeoutMs, token } = options;
  const env = { ...process.env };
  if (runtime.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
    env.ELECTRON_NO_ATTACH_CONSOLE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(runtime.command, [cliPath], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      reject(runtimeError(runtime, error));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let tooLarge = false;
    let cancelDisposable = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelDisposable?.dispose) cancelDisposable.dispose();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    if (token?.onCancellationRequested) {
      cancelDisposable = token.onCancellationRequested(() => {
        cancelled = true;
        try { child.kill(); } catch { /* ignore */ }
      });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_BYTES) {
        tooLarge = true;
        try { child.kill(); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });
    child.on('error', (error) => settle(runtimeError(runtime, error)));
    child.on('close', (status) => {
      if (cancelled) {
        settle(new AppError(ERROR_CODES.CANCELLED, '操作已取消。', { retryable: true }));
        return;
      }
      if (timedOut) {
        settle(new AppError(ERROR_CODES.RUNTIME_UNAVAILABLE, `CLI 在 ${timeoutMs}ms 内未响应。`, {
          retryable: true,
          details: { stderr }
        }));
        return;
      }
      if (tooLarge) {
        settle(new AppError(ERROR_CODES.INTERNAL_ERROR, 'CLI 响应超过大小上限。'));
        return;
      }
      settle(null, { status, stdout, stderr });
    });
    try {
      child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
      child.stdin.end(requestText);
    } catch (error) {
      settle(runtimeError(runtime, error));
    }
  });
}

/**
 * @param {{status: number|null, stdout: string, stderr: string}} result
 * @param {string} requestId
 * @returns {any}
 */
function parseResponse(result, requestId) {
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      `CLI 响应无效：期望 1 行 JSON，实际 ${lines.length} 行。`,
      { details: { stderr: result.stderr } }
    );
  }
  let response;
  try {
    response = JSON.parse(lines[0]);
  } catch {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'CLI 响应不是合法 JSON。', {
      details: { stderr: result.stderr }
    });
  }
  if (!isPlainObject(response)
    || !SUPPORTED_PROTOCOL_VERSIONS.includes(response.protocolVersion)
    || response.requestId !== requestId
    || typeof response.ok !== 'boolean') {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'CLI 响应信封无效。', {
      details: { stderr: result.stderr }
    });
  }
  if (result.status !== 0 && response.ok) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, `CLI 以退出码 ${result.status} 结束，但返回成功。`, {
      details: { stderr: result.stderr }
    });
  }
  if (!response.ok) {
    const error = response.error;
    if (!isPlainObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'CLI 错误响应格式无效。');
    }
    if (!Object.values(ERROR_CODES).includes(error.code)) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `CLI 返回未知错误码：${error.code}`, {
        details: { originalError: error }
      });
    }
    throw new AppError(error.code, error.message, {
      retryable: Boolean(error.retryable),
      operationId: typeof error.operationId === 'string' ? error.operationId : undefined,
      details: error.details
    });
  }
  return response.data;
}

/**
 * @param {object} runtime
 * @param {Error} error
 */
function runtimeError(runtime, error) {
  if (error instanceof AppError) return error;
  return new AppError(
    ERROR_CODES.RUNTIME_UNAVAILABLE,
    `无法启动 CLI（${runtime.label}）：${error.message}`,
    { cause: normalizeError(error), retryable: true }
  );
}

module.exports = {
  runProcess,
  parseResponse
};

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { AppError } = require('../shared/errors');
const {
  ERROR_CODES,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS
} = require('../shared/constants');
const { isPlainObject } = require('../shared/json');
const { OPERATION_SET } = require('../shared/protocol');
const { runProcess, parseResponse } = require('./cli-process');

const HEALTH_TIMEOUT_MS = 20000;

/**
 * 扩展宿主的 CLI 客户端。只使用异步 spawn，绝不阻塞 Extension Host。
 * 生产环境使用管道；测试可通过 spawnImpl 注入。
 */
class CliClient {
  /**
   * @param {{extensionPath: string, outputChannel?: {appendLine: Function}, getConfig?: Function, spawnImpl?: Function, nodePath?: string}} options
   */
  constructor(options) {
    this.extensionPath = options.extensionPath;
    this.cliPath = path.join(options.extensionPath, 'src', 'cli', 'index.js');
    this.outputChannel = options.outputChannel;
    this.getConfig = options.getConfig || (() => ({}));
    this.spawnImpl = options.spawnImpl || spawn;
    this.nodePath = options.nodePath;
    this.runtime = null;
    this.runtimeErrors = [];
  }

  /**
   * @param {string} operation
   * @param {object} payload
   * @param {{token?: object, timeoutMs?: number}} [options]
   * @returns {Promise<unknown>}
   */
  async request(operation, payload, options = {}) {
    if (typeof operation !== 'string' || !OPERATION_SET.has(operation)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, `未知操作：${operation}`);
    }
    if (!isPlainObject(payload)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'payload 必须是普通对象。');
    }
    const runtime = await this.ensureRuntime();
    const requestId = `ext_${crypto.randomUUID()}`;
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      operation,
      payload
    };
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '请求超过大小上限。');
    }
    const timeoutMs = options.timeoutMs || this.configuredTimeout();
    return this.execute(runtime, text, requestId, { token: options.token, timeoutMs });
  }

  /**
   * @returns {Promise<object>}
   */
  async ensureRuntime() {
    if (this.runtime) return this.runtime;
    const candidates = this.runtimeCandidates();
    const errors = [];
    for (const candidate of candidates) {
      try {
        const health = await this.probe(candidate);
        this.runtime = { ...candidate, health };
        this.runtimeErrors = errors;
        this.log(`CLI 运行时：${candidate.label} (Node ${health.nodeVersion}, SQLite ${health.sqlite.version})`);
        return this.runtime;
      } catch (error) {
        errors.push({ label: candidate.label, message: error.message });
        this.log(`CLI 运行时不可用：${candidate.label}：${error.message}`);
      }
    }
    this.runtime = null;
    this.runtimeErrors = errors;
    throw new AppError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      '无法启动项目管理 CLI。请确认 VS Code 安装完整，或在设置 projectManager.nodePath 中指定 Node >= 22.13 的路径。',
      { details: { attempts: errors }, retryable: true }
    );
  }

  /**
   * @returns {Array<{command: string, label: string, electron: boolean}>}
   */
  runtimeCandidates() {
    const candidates = [];
    const seen = new Set();
    const add = (command, label, electron) => {
      if (!command) return;
      const key = `${command.toLowerCase()}|${electron ? 'electron' : 'node'}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        command,
        label,
        electron: electron || /code|electron/i.test(path.basename(command))
      });
    };
    const configured = String(this.nodePath || '').trim()
      || String(configValue(this.getConfig(), 'nodePath') || '').trim();
    if (configured) add(configured, 'projectManager.nodePath', false);
    add(process.execPath, 'VS Code 内置 Node', true);
    add('node', 'PATH 中的 node', false);
    return candidates;
  }

  /**
   * @param {{command: string, label: string, electron: boolean}} runtime
   * @returns {Promise<object>}
   */
  async probe(runtime) {
    if (runtime.command.includes('\u0000')) {
      throw new AppError(ERROR_CODES.RUNTIME_UNAVAILABLE, '运行时路径包含非法字符。');
    }
    const requestId = `health_${crypto.randomUUID()}`;
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      operation: 'system.health',
      payload: {}
    };
    const health = await this.execute(runtime, JSON.stringify(request), requestId, {
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (health.sqlite?.available !== true) {
      throw new AppError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `运行时 Node ${health.nodeVersion} 不支持 node:sqlite：${health.sqlite?.error || '未知原因'}`
      );
    }
    const version = parseNodeVersion(health.nodeVersion);
    if (version.major < 22 || (version.major === 22 && version.minor < 13)) {
      throw new AppError(
        ERROR_CODES.RUNTIME_UNAVAILABLE,
        `Node ${health.nodeVersion} 过低，需要 Node >= 22.13。`
      );
    }
    return health;
  }

  /**
   * @param {object} runtime
   * @param {string} requestText
   * @param {string} requestId
   * @param {{token?: object, timeoutMs?: number}} options
   * @returns {Promise<any>}
   */
  async execute(runtime, requestText, requestId, options) {
    const result = await runProcess({
      spawnImpl: this.spawnImpl,
      cliPath: this.cliPath,
      cwd: this.extensionPath,
      runtime,
      requestText,
      timeoutMs: options.timeoutMs || this.configuredTimeout(),
      token: options.token
    });
    return parseResponse(result, requestId);
  }

  /**
   * @param {{status: number|null, stdout: string, stderr: string}} result
   * @param {string} requestId
   * @returns {any}
   */
  parseResponse(result, requestId) {
    return parseResponse(result, requestId);
  }

  configuredTimeout() {
    const value = Number(configValue(this.getConfig(), 'requestTimeoutMs'));
    if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
    return Math.min(600000, Math.max(5000, Math.floor(value)));
  }

  /**
   * @param {string} message
   */
  log(message) {
    if (this.outputChannel?.appendLine) {
      this.outputChannel.appendLine(`[project-manager] ${message}`);
    }
  }

  resetRuntime() {
    this.runtime = null;
    this.runtimeErrors = [];
  }
}

/**
 * @param {object|undefined} config
 * @param {string} key
 * @returns {unknown}
 */
function configValue(config, key) {
  if (!config) return undefined;
  if (typeof config.get === 'function') return config.get(key);
  return config[key];
}

/**
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number}}
 */
function parseNodeVersion(version) {
  const parts = String(version).split('.').map((item) => Number.parseInt(item, 10));
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 0,
    minor: Number.isFinite(parts[1]) ? parts[1] : 0,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0
  };
}

module.exports = {
  CliClient,
  parseNodeVersion
};

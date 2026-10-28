'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CLI_PATH = path.resolve(__dirname, '../../src/cli/index.js');

/**
 * 以子进程方式运行 CLI，验证真实 stdin/stdout 协议。
 *
 * 注意：当前开发沙箱禁止匿名管道，因此测试用临时文件充当 stdio。
 * 扩展宿主中的 CliClient 使用管道，不受这里影响。
 * @param {object|string} request
 * @param {{timeoutMs?: number, env?: Record<string,string>, nodePath?: string}} [options]
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string, json: object|null, elapsedMs: number, timedOut: boolean}>}
 */
async function runCli(request, options = {}) {
  const text = Buffer.isBuffer(request)
    ? request
    : Buffer.from(typeof request === 'string' ? request : JSON.stringify(request), 'utf8');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-cli-'));
  const inputPath = path.join(temp, 'stdin.json');
  const outputPath = path.join(temp, 'stdout.txt');
  const errorPath = path.join(temp, 'stderr.txt');
  await fsp.writeFile(inputPath, text);
  const inputFd = fs.openSync(inputPath, 'r');
  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');
  const started = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(options.nodePath || process.execPath, [CLI_PATH], {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, ...options.env },
        stdio: [inputFd, outputFd, errorFd],
        windowsHide: true
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs || 30000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', async (status, signal) => {
        clearTimeout(timer);
        const stdout = await fsp.readFile(outputPath, 'utf8').catch(() => '');
        const stderr = await fsp.readFile(errorPath, 'utf8').catch(() => '');
        let json = null;
        try {
          json = JSON.parse(stdout.trim());
        } catch {
          json = null;
        }
        resolve({
          status: timedOut ? null : status,
          signal,
          stdout,
          stderr,
          json,
          elapsedMs: Date.now() - started,
          timedOut
        });
      });
    });
  } finally {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  CLI_PATH,
  runCli
};

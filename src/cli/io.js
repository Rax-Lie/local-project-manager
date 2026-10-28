'use strict';

const { AppError } = require('../shared/errors');
const { ERROR_CODES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require('../shared/constants');

/**
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
function readStdin(maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    process.stdin.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(new AppError(
          ERROR_CODES.INVALID_REQUEST,
          `请求超过 ${maxBytes} 字节上限。`,
          { details: { maxBytes } }
        ));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => finish(null, Buffer.concat(chunks)));
    process.stdin.on('error', (error) => finish(error));
  });
}

/**
 * @param {Buffer} buffer
 * @returns {unknown}
 */
function decodeAndParse(buffer) {
  if (buffer.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'stdin 为空。');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'stdin 不是合法 UTF-8。');
  }
  if (!text.trim()) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, 'stdin 只有空白字符。');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, `请求不是合法 JSON：${error.message}`);
  }
}

/**
 * stdout 只写一条响应；超限时降级为明确的内部错误。
 * @param {object} response
 * @returns {boolean}
 */
function writeResponse(response) {
  let text = JSON.stringify(response);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    text = JSON.stringify({
      protocolVersion: response.protocolVersion,
      requestId: response.requestId,
      ok: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: `响应超过 ${MAX_RESPONSE_BYTES} 字节上限。`,
        retryable: false
      }
    });
  }
  process.stdout.write(`${text}\n`);
  return true;
}

/**
 * @param {string} message
 */
function writeDiagnostic(message) {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* stderr 不可用时忽略诊断 */
  }
}

module.exports = {
  readStdin,
  decodeAndParse,
  writeResponse,
  writeDiagnostic
};

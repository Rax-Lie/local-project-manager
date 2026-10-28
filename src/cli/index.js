#!/usr/bin/env node
'use strict';

const { normalizeError } = require('../shared/errors');
const { validateRequestEnvelope, successResponse, errorResponse } = require('../shared/protocol');
const { decodeAndParse, readStdin, writeResponse, writeDiagnostic } = require('./io');
const { dispatch } = require('./dispatch');

async function main() {
  let requestId = '';
  try {
    const buffer = await readStdin();
    const raw = decodeAndParse(buffer);
    if (raw && typeof raw === 'object' && typeof raw.requestId === 'string' && raw.requestId.length <= 128) {
      requestId = raw.requestId;
    }
    const request = validateRequestEnvelope(raw);
    requestId = request.requestId;
    const data = await dispatch(request.operation, request.payload);
    writeResponse(successResponse(requestId, data));
    return 0;
  } catch (error) {
    const appError = normalizeError(error);
    writeDiagnostic(`[project-manager-cli] ${appError.code}: ${appError.message}`);
    writeResponse(errorResponse(requestId, appError));
    return 0;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  writeDiagnostic(`[project-manager-cli] fatal: ${error?.stack || error}`);
  process.exitCode = 1;
});

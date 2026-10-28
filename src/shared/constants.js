'use strict';

/** CLI 与扩展之间的协议版本。任何信封格式变化都必须提升此版本。 */
const PROTOCOL_VERSION = 1;
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_MESSAGE_CHARS = 8000;
const MAX_DISPLAY_NAME_CHARS = 120;

const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  ROOT_NOT_INITIALIZED: 'ROOT_NOT_INITIALIZED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  CONFLICT: 'CONFLICT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  DATABASE_BUSY: 'DATABASE_BUSY',
  OPERATION_INCOMPLETE: 'OPERATION_INCOMPLETE',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  CANCELLED: 'CANCELLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

const RETRYABLE_CODES = Object.freeze(new Set([
  ERROR_CODES.RUNTIME_UNAVAILABLE,
  ERROR_CODES.DATABASE_BUSY,
  ERROR_CODES.OPERATION_INCOMPLETE
]));

const PROJECT_STATUSES = Object.freeze([
  'provisioning',
  'active',
  'archiving',
  'archived',
  'needs_recovery'
]);

const OPERATION_STATES = Object.freeze([
  'planned',
  'applying',
  'awaiting_workspace',
  'completed',
  'needs_recovery',
  'undone'
]);

const OPERATION_KINDS = Object.freeze([
  'root.initialize',
  'project.create',
  'project.archive',
  'project.file.write'
]);

const PM_DIR = '.pm';
const CONFIG_FILE = 'pm.json';
const DB_FILE = 'pm.sqlite';
const SNAPSHOT_FILE = '.pm-project.json';
const TEMPLATES_DIR = 'templates';
const BACKUPS_DIR = 'backups';
const ROOT_INIT_MARKER = '.pm-root-initialize.json';

const DEFAULT_PARTITIONS = Object.freeze([
  Object.freeze({ id: 'inbox', name: '收件箱', relativePath: 'inbox' }),
  Object.freeze({ id: 'projects', name: '项目', relativePath: 'projects' }),
  Object.freeze({ id: 'archive', name: '归档', relativePath: 'archive' })
]);

const DEFAULT_SLUG_RULES = Object.freeze({
  pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
  maxLength: 64,
  lowercase: true
});

const FIELD_TYPES = Object.freeze(['text', 'number', 'date', 'boolean', 'choice']);

const LIMITS = Object.freeze({
  maxFields: 50,
  maxChoices: 100,
  maxDirectoryEntries: 100,
  maxMarkdownTemplates: 20,
  maxMarkdownBytes: 1024 * 1024,
  maxTextFieldChars: 10000,
  maxTemplateJsonBytes: 512 * 1024,
  maxSearchLimit: 500,
  defaultSearchLimit: 50
});

const ROOT_SCHEMA_VERSION = 1;
const ROOT_CONFIG_FILE_VERSION = 1;

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STDERR_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  ERROR_CODES,
  RETRYABLE_CODES,
  PROJECT_STATUSES,
  OPERATION_STATES,
  OPERATION_KINDS,
  PM_DIR,
  CONFIG_FILE,
  DB_FILE,
  SNAPSHOT_FILE,
  TEMPLATES_DIR,
  BACKUPS_DIR,
  ROOT_INIT_MARKER,
  DEFAULT_PARTITIONS,
  DEFAULT_SLUG_RULES,
  FIELD_TYPES,
  LIMITS,
  ROOT_SCHEMA_VERSION,
  ROOT_CONFIG_FILE_VERSION
};

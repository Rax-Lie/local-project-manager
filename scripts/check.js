'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const MAX_LINES = 300;
const failures = [];

/**
 * @param {string} message
 */
function fail(message) {
  failures.push(message);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(full);
  }
  return result;
}

const files = walk(SRC);
for (const file of files) {
  const relative = path.relative(ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.replace(/\r?\n$/, '').split(/\r?\n/).length;
  if (lines >= MAX_LINES) fail(`${relative} 有 ${lines} 行，必须小于 ${MAX_LINES} 行。`);
  const parseSource = source.startsWith('#!') ? source.replace(/^#![^\n]*\n/, '\n') : source;
  try {
    new vm.Script(parseSource, { filename: relative });
  } catch (error) {
    fail(`${relative} 语法错误：${error.message}`);
  }
  if (relative.startsWith(`src${path.sep}extension`) && /\b(?:spawnSync|execSync|execFileSync)\s*\(/.test(source)) {
    fail(`${relative} 使用了阻塞式子进程 API，会冻结 Extension Host。`);
  }
  if (/\bconsole\.log\s*\(/.test(source)) {
    fail(`${relative} 使用了 console.log；CLI stdout 只能写单条协议响应。`);
  }
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (error) {
  fail(`package.json 无法解析：${error.message}`);
}

if (manifest) {
  if (!manifest.main || !fs.existsSync(path.join(ROOT, manifest.main))) {
    fail(`package.json main 指向不存在的文件：${manifest.main}`);
  }
  if (!manifest.engines?.vscode) fail('package.json 缺少 engines.vscode。');
  if (!Array.isArray(manifest.contributes?.commands) || manifest.contributes.commands.length === 0) {
    fail('package.json 未贡献任何命令。');
  }
  const ids = new Set();
  for (const command of manifest.contributes?.commands || []) {
    if (ids.has(command.command)) fail(`命令重复：${command.command}`);
    ids.add(command.command);
    if (!manifest.activationEvents?.includes(`onCommand:${command.command}`)
      && !['projectManager.openProject', 'projectManager.copyProjectInfo'].includes(command.command)) {
      fail(`命令缺少激活事件：${command.command}`);
    }
  }
  if (manifest.icon && !fs.existsSync(path.join(ROOT, manifest.icon))) {
    fail(`package.json icon 不存在：${manifest.icon}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'README.md'))) fail('缺少 README.md。');
  if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) fail('缺少 LICENSE。');
}

const testFiles = walk(path.join(ROOT, 'tests')).filter((file) => file.endsWith('.test.js'));
if (testFiles.length === 0) fail('没有找到测试文件。');

if (failures.length > 0) {
  console.error(`检查失败（${failures.length} 项）：`);
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`检查通过：${files.length} 个源文件，${testFiles.length} 个测试文件，全部模块小于 ${MAX_LINES} 行。`);
}

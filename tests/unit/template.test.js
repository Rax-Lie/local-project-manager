'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectTemplateErrors,
  validateTemplate,
  renderMarkdown
} = require('../../src/domain/template');
const { normalizeFieldValues } = require('../../src/domain/field-values');
const { DEFAULT_TEMPLATES } = require('../../src/application/defaults');

function template(overrides = {}) {
  return {
    id: 'demo',
    revision: 1,
    displayName: '演示',
    fields: [
      { id: 'title', label: '标题', type: 'text', required: true },
      { id: 'count', label: '数量', type: 'number', required: false, defaultValue: 1 },
      { id: 'due', label: '日期', type: 'date', required: false },
      { id: 'done', label: '完成', type: 'boolean', required: false, defaultValue: false },
      { id: 'level', label: '级别', type: 'choice', required: false, choices: ['低', '高'], defaultValue: '低' }
    ],
    directoryBlueprint: ['docs'],
    markdownTemplates: [{ id: 'readme', targetPath: 'README.md', content: '# ${project.displayName}' }],
    ...overrides
  };
}

test('内置模板全部通过校验', () => {
  for (const item of DEFAULT_TEMPLATES) {
    assert.deepEqual(collectTemplateErrors(item), []);
    assert.equal(validateTemplate(item), item);
  }
});

test('模板结构错误聚合返回', () => {
  const errors = collectTemplateErrors(template({
    id: 'Bad ID',
    revision: 0,
    fields: [
      { id: 'x', label: '', type: 'text', required: 'yes' },
      { id: 'x', label: '重复', type: 'choice', required: true, choices: [] }
    ],
    directoryBlueprint: ['../escape', 'CON'],
    markdownTemplates: [{ id: 'a', targetPath: '../x.md', content: '' }]
  }));
  assert.ok(errors.length >= 6);
  assert.ok(errors.some((item) => item.includes('revision')));
  assert.ok(errors.some((item) => item.includes('重复')));
});

test('normalizeFieldValues 填充默认值并拒绝未知/必填缺失', () => {
  const values = normalizeFieldValues(template(), { title: '标题' });
  assert.deepEqual(values, {
    title: '标题',
    count: 1,
    due: null,
    done: false,
    level: '低'
  });
  assert.throws(() => normalizeFieldValues(template(), {}), /必填/);
  assert.throws(() => normalizeFieldValues(template(), { title: 'x', extra: 1 }), /未知模板字段/);
  assert.throws(() => normalizeFieldValues(template(), { title: 'x', count: '1' }), /数字/);
  assert.throws(() => normalizeFieldValues(template(), { title: 'x', due: '2026-02-30' }), /日期/);
  assert.throws(() => normalizeFieldValues(template(), { title: 'x', level: '中' }), /choices/);
});

test('renderMarkdown 替换项目、根和字段变量', () => {
  const result = renderMarkdown(
    '# ${project.displayName}\n${field.title}\n${field.count}\n${field.done}\n${root.displayName}\n${date.today}',
    {
      project: {
        displayName: '项目A',
        slug: 'a',
        relativePath: 'projects/a',
        createdAt: '2026-10-28T00:00:00.000Z'
      },
      root: { displayName: '根A', rootId: 'root_x' },
      fieldValues: { title: '标题', count: 3, done: true }
    }
  );
  assert.match(result, /# 项目A/);
  assert.match(result, /标题/);
  assert.match(result, /3/);
  assert.match(result, /是/);
  assert.match(result, /根A/);
  assert.match(result, /\d{4}-\d{2}-\d{2}/);
});

test('renderMarkdown 遇到未知变量时拒绝', () => {
  assert.throws(() => renderMarkdown('${unknown.value}', { project: {}, root: {}, fieldValues: {} }),
    /未知变量/);
});

'use strict';

/**
 * 按模板 schema 逐项收集字段值。返回 undefined 表示用户取消。
 * @param {object} vscode
 * @param {object} template
 * @returns {Promise<Record<string, unknown>|undefined>}
 */
async function askProjectFields(vscode, template) {
  const values = {};
  for (const field of template.fields || []) {
    const value = await askField(vscode, field);
    if (value === undefined) return undefined;
    values[field.id] = value;
  }
  return values;
}

/**
 * @param {object} vscode
 * @param {object} field
 * @returns {Promise<unknown|undefined>}
 */
async function askField(vscode, field) {
  if (field.type === 'choice') {
    const defaultIndex = field.defaultValue === undefined ? -1 : field.choices.indexOf(field.defaultValue);
    const items = field.choices.map((choice, index) => ({
      label: choice,
      description: index === defaultIndex ? '默认' : '',
      value: choice
    }));
    if (defaultIndex > 0) {
      const [item] = items.splice(defaultIndex, 1);
      items.unshift(item);
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: field.label,
      placeHolder: `选择${field.label}${field.required ? '（必填）' : ''}`
    });
    return picked ? picked.value : undefined;
  }
  if (field.type === 'boolean') {
    const defaultValue = field.defaultValue === true;
    const items = [
      { label: '是', description: defaultValue ? '默认' : '', value: true },
      { label: '否', description: defaultValue ? '' : '默认', value: false }
    ];
    if (!defaultValue) items.reverse();
    const picked = await vscode.window.showQuickPick(items, {
      title: field.label,
      placeHolder: `选择${field.label}`
    });
    return picked ? picked.value : undefined;
  }

  const defaultValue = field.defaultValue === null || field.defaultValue === undefined
    ? ''
    : String(field.defaultValue);
  const value = await vscode.window.showInputBox({
    title: field.label,
    prompt: promptFor(field),
    value: defaultValue,
    placeHolder: placeholderFor(field),
    validateInput: (input) => validateFieldInput(field, input)
  });
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return field.required ? undefined : null;
  if (field.type === 'number') return Number(trimmed);
  return trimmed;
}

/**
 * @param {object} field
 * @returns {string}
 */
function promptFor(field) {
  const required = field.required ? '必填' : '可选';
  switch (field.type) {
    case 'date': return `${required}，格式 YYYY-MM-DD。`;
    case 'number': return `${required}，请输入数字。`;
    default: return `${required}，可输入多行以外的文本。`;
  }
}

/**
 * @param {object} field
 * @returns {string}
 */
function placeholderFor(field) {
  if (field.type === 'date') return '2026-10-28';
  if (field.type === 'number') return '0';
  return field.required ? '必填' : '留空表示不填写';
}

/**
 * @param {object} field
 * @param {string} input
 * @returns {string|null}
 */
function validateFieldInput(field, input) {
  const value = String(input || '').trim();
  if (!value) return field.required ? `${field.label} 为必填项。` : null;
  if (field.type === 'number' && !Number.isFinite(Number(value))) return '请输入有效数字。';
  if (field.type === 'date' && !isValidDate(value)) return '请输入 YYYY-MM-DD 格式的有效日期。';
  if (field.type === 'text' && value.length > 10000) return '文本不能超过 10000 字符。';
  return null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * @param {object} vscode
 * @returns {Promise<string|undefined>}
 */
async function askProjectName(vscode, initialValue = '') {
  const value = await vscode.window.showInputBox({
    title: '项目名称',
    prompt: '用于工作区显示名称；目录 slug 将根据该名称生成，纯中文名称会得到稳定的哈希 slug。',
    value: initialValue,
    placeHolder: '例如：客户门户改版',
    validateInput: (input) => {
      if (!input || !input.trim()) return '项目名称不能为空。';
      if (input.trim().length > 120) return '项目名称不能超过 120 字符。';
      return null;
    }
  });
  return value === undefined ? undefined : value.trim();
}

module.exports = {
  askProjectFields,
  askProjectName,
  isValidDate
};

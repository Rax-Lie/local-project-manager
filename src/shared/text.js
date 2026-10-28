'use strict';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * 显示名称、标签等单行文本不能包含 C0 控制字符。
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacters(value) {
  return typeof value === 'string' && CONTROL_CHARACTERS.test(value);
}

module.exports = {
  hasControlCharacters
};

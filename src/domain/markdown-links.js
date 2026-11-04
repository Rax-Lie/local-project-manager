'use strict';

function extractMarkdownLinks(markdown) {
  const masked = maskCode(markdown);
  const { references, ranges } = readReferenceDefinitions(masked);
  const body = maskRanges(masked, ranges);
  const links = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '[' || isEscaped(body, index)) continue;
    const close = readBracket(body, index);
    if (close < 0) continue;
    const next = skipSpaces(body, close + 1);
    if (body[next] === '(') {
      const parsed = readInlineDestination(body, next);
      if (parsed) {
        links.push({ destination: parsed.value, start: parsed.start, end: parsed.end, kind: 'inline' });
        index = parsed.close;
      }
      continue;
    }
    if (body[next] === '[') {
      const refClose = readBracket(body, next);
      if (refClose >= 0) {
        const label = body.slice(next + 1, refClose) || body.slice(index + 1, close);
        addReference(links, references, label, index);
        index = refClose;
      }
      continue;
    }
    addReference(links, references, body.slice(index + 1, close), index);
    index = close;
  }
  links.push(...readHtmlLinks(body));
  return links.sort((a, b) => a.start - b.start);
}

function readReferenceDefinitions(text) {
  const references = new Map();
  const ranges = [];
  const pattern = /^ {0,3}\[([^\]\r\n]+)\]:\s*(?:<([^>\r\n]+)>|(\S+))/gm;
  let match;
  while ((match = pattern.exec(text))) {
    const destination = match[2] || match[3];
    const destinationOffset = match.index + match[0].indexOf(destination);
    references.set(normalizeLabel(match[1]), { destination, start: destinationOffset, end: destinationOffset + destination.length });
    ranges.push([match.index, match.index + match[0].length]);
  }
  return { references, ranges };
}

function readHtmlLinks(text) {
  const links = [];
  const pattern = /\b(?:href|src)\s*=\s*(["'])([^"'<>\r\n]*)\1/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].lastIndexOf(match[2]);
    links.push({ destination: match[2], start, end: start + match[2].length, kind: 'html' });
  }
  return links;
}

function readInlineDestination(text, open) {
  let cursor = skipSpaces(text, open + 1);
  let start = cursor;
  if (text[cursor] === '<') {
    start = cursor + 1;
    cursor = start;
    while (cursor < text.length && (text[cursor] !== '>' || isEscaped(text, cursor))) cursor += 1;
    if (cursor >= text.length) return null;
    return { value: text.slice(start, cursor), start, end: cursor, close: skipSpaces(text, cursor + 1) };
  }
  let depth = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') { cursor += 2; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (/\s/.test(char) && depth === 0) break;
    cursor += 1;
  }
  const raw = text.slice(start, cursor);
  const close = raw.length > 0 && depth === 0 ? findClosingParen(text, cursor) : -1;
  if (close < 0) return null;
  return { value: unescapeMarkdown(raw), start, end: cursor, close };
}

function findClosingParen(text, start) {
  let cursor = skipSpaces(text, start);
  if (text[cursor] === '"' || text[cursor] === "'") {
    const quote = text[cursor++];
    while (cursor < text.length && (text[cursor] !== quote || isEscaped(text, cursor))) cursor += 1;
    if (cursor >= text.length) return -1;
    cursor = skipSpaces(text, cursor + 1);
  }
  return text[cursor] === ')' ? cursor : -1;
}

function readBracket(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === '[') depth += 1;
    if (text[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function addReference(links, references, label, occurrence) {
  const definition = references.get(normalizeLabel(label));
  if (definition) links.push({ ...definition, kind: 'reference', occurrence });
}

function normalizeLabel(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function skipSpaces(text, index) {
  while (index < text.length && /[ \t\r\n]/.test(text[index])) index += 1;
  return index;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function unescapeMarkdown(value) {
  return value.replace(/\\([\\`*_{}[\]()#+.!<>|~-])/g, '$1');
}

function maskCode(text) {
  const chars = text.split('');
  let offset = 0;
  let fence = null;
  for (const line of text.match(/.*(?:\r?\n|$)/g) || []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      blank(chars, offset, offset + line.length);
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) fence = null;
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      blank(chars, offset, offset + line.length);
    }
    offset += line.length;
  }
  const inline = chars.join('');
  let cursor = 0;
  while (cursor < inline.length) {
    if (inline[cursor] !== '`' || isEscaped(inline, cursor)) { cursor += 1; continue; }
    let endRun = cursor + 1;
    while (inline[endRun] === '`') endRun += 1;
    const run = inline.slice(cursor, endRun);
    let close = inline.indexOf(run, endRun);
    while (close >= 0 && isEscaped(inline, close)) close = inline.indexOf(run, close + run.length);
    if (close < 0) { cursor = endRun; continue; }
    blank(chars, cursor, close + run.length);
    cursor = close + run.length;
  }
  return chars.join('');
}

function maskRanges(text, ranges) {
  const chars = text.split('');
  for (const [start, end] of ranges) blank(chars, start, end);
  return chars.join('');
}

function blank(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

module.exports = { extractMarkdownLinks };

/**
 * Chat Markdown rendering tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/markdown.test.ts
 *   (or: npm run test:markdown)
 *
 * The parser only has to handle one model's chat prose, but it has to handle it
 * without ever throwing or dropping text — a bubble that silently loses half a
 * sentence is worse than one showing raw asterisks. Every case here is either
 * something Claude actually emits or a way a naive regex would corrupt the text.
 */

import { parseInline, parseMarkdown, stripMarkdown } from '../src/lib/markdown';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Concatenated span text must always equal the input minus its delimiters. */
const rendered = (s: string) => parseInline(s).map((t) => t.text).join('');

console.log('\nInline');

check('plain text is one span', (() => {
  const t = parseInline('just words');
  return t.length === 1 && t[0].type === 'text' && t[0].text === 'just words';
})());

check('**bold** becomes a bold span', (() => {
  const t = parseInline('a **very** b');
  return t.length === 3 && t[1].type === 'bold' && t[1].text === 'very';
})());

check('*italic* and _italic_ both work', (() => {
  const a = parseInline('x *em* y')[1];
  const b = parseInline('x _em_ y')[1];
  return a.type === 'italic' && b.type === 'italic' && a.text === 'em';
})());

check('***bold italic*** is not eaten as ** + *', (() => {
  const t = parseInline('a ***both*** b');
  return t[1].type === 'boldItalic' && t[1].text === 'both';
})());

check('`code` becomes a code span', (() => {
  const t = parseInline('run `pod install` now');
  return t[1].type === 'code' && t[1].text === 'pod install';
})());

check('multiple emphases in one line', (() => {
  const t = parseInline('**a** and **b**');
  return t.filter((x) => x.type === 'bold').length === 2;
})());

// The failure mode that matters: a lone delimiter must not swallow the rest.
check('an unclosed ** stays literal', rendered('2 ** 3 is not bold') === '2 ** 3 is not bold');
check('a lone * stays literal', rendered('5 * 4 = 20') === '5 * 4 = 20');
check('underscores inside words survive', rendered('call issue_ids please') === 'call issue_ids please');

// Ignoring delimiter characters entirely — whether they were consumed as
// markup or left literal — every other character must survive, in order.
check('no text is ever dropped', (() => {
  const samples = [
    'plain', '**b**', '*i*', '`c`', 'a**b**c', '** unclosed', 'a_b_c',
    'mixed **b** and *i* and `c`', '', '***x***', '*a **b** c*', '5 * 4 * 3',
  ];
  const delimiters = /[*_`]/g;
  const failed = samples.filter(
    (s) => rendered(s).replace(delimiters, '') !== s.replace(delimiters, ''),
  );
  return failed.length === 0;
})(), 'a sample lost characters');

console.log('\nBlocks');

check('hard-wrapped prose joins into one paragraph', (() => {
  const b = parseMarkdown('the quick\nbrown fox');
  return b.length === 1 && b[0].type === 'paragraph' && b[0].spans[0].text === 'the quick brown fox';
})());

check('a blank line separates paragraphs', parseMarkdown('one\n\ntwo').length === 2);

check('- and * bullets are recognised', (() => {
  const b = parseMarkdown('- first\n* second');
  return b.length === 2 && b.every((x) => x.type === 'bullet');
})());

check('numbered lists keep their marker', (() => {
  const b = parseMarkdown('1. first\n2. second');
  return b.length === 2 && b[0].type === 'numbered' && b[0].marker === '1.';
})());

check('bullets keep their inline emphasis', (() => {
  const b = parseMarkdown('- do **this** first');
  return b[0].type === 'bullet' && b[0].spans.some((s) => s.type === 'bold');
})());

check('a heading degrades to bold rather than showing #', (() => {
  const b = parseMarkdown('## Practice plan');
  return b.length === 1 && b[0].spans[0].type === 'bold' && b[0].spans[0].text === 'Practice plan';
})());

check('a paragraph before a list is kept', (() => {
  const b = parseMarkdown('Try this:\n- one\n- two');
  return b.length === 3 && b[0].type === 'paragraph' && b[1].type === 'bullet';
})());

check('empty input yields no blocks', parseMarkdown('').length === 0);

console.log('\nRealistic reply');

// The shape of an actual coach reply, from the deployed function.
const reply = `I hear you—shoulder ache is a real barrier.

Your last session showed **thin tone in the upper bow**. The drill helps because:

- It builds *sustained* arm weight
- Six minutes is enough to feel it

Are you finding it helps?`;

check('parses without throwing', (() => {
  const b = parseMarkdown(reply);
  return b.length > 0;
})());

check('finds both bullets', parseMarkdown(reply).filter((b) => b.type === 'bullet').length === 2);

check('strips to clean plain text for accessibility', (() => {
  const plain = stripMarkdown(reply);
  return !plain.includes('**') && !plain.includes('- ') && plain.includes('thin tone in the upper bow');
})());

if (failures > 0) {
  console.error(`\n${failures} failing check(s)`);
  process.exit(1);
}
console.log('\nAll markdown checks passed.');

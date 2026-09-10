import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../apps/remote-web/src/MarkdownMessage.js';

function render(text: string, id = 'assistant-message') { return renderToStaticMarkup(createElement(MarkdownMessage, { text, id })); }
it('renders assistant Markdown and GFM structures with separate code/table scroll regions', () => {
  const html = render('# 标题\n\n**加粗**与 `inline`\n\n1. 步骤\n   - 子项\n\n> 引用\n\n- [x] 已完成\n- [ ] 未完成\n\n| 名称 | 数量 |\n| :--- | ---: |\n| Turnwire | 2 |\n\n```ts\nconst value = "<div>";\n```');
  expect(html).toContain('<h1>标题</h1>'); expect(html).toContain('<strong>加粗</strong>');
  expect(html).toContain('<ol>'); expect(html).toContain('<blockquote>');
  expect(html).toContain('type="checkbox"'); expect(html).toContain('disabled=""');
  expect(html).toContain('class="markdown-table"'); expect(html).toContain('class="align-right"');
  expect(html).toContain('class="markdown-code"'); expect(html).toContain('class="language-ts"');
  expect(html).toContain('&lt;div&gt;'); expect(html).toContain('复制代码');
});
it('preserves unclosed streaming fences, indentation, blank lines and literal backticks', () => {
  const partial = '```ts\nfunction example() {\n  return `literal`;\n\n';
  const initial = render(partial); expect(initial).toContain('class="language-ts"'); expect(initial).toContain('  return `literal`;\n\n');
  const complete = render(partial + '}\n```\n\n完成。'); expect(complete).toContain('<p>完成。</p>'); expect(complete.match(/<pre /g)).toHaveLength(1);
  const nested = render('````md\n```js\nconst x = 1;\n```\n````'); expect(nested).toContain('```js\nconst x = 1;\n```');
});
it('renders hard breaks and isolates footnote anchors between messages', () => {
  const source = '第一行  \n第二行[^1]\n\n[^1]: 说明';
  const one = render(source, 'first'), two = render(source, 'second');
  expect(one).toContain('<br/>'); expect(one).toContain('href="#turnwire-first-fn-1"');
  expect(two).toContain('id="turnwire-second-fn-1"'); expect(two).not.toContain('#turnwire-first-');
});
it('keeps untrusted HTML inert and blocks script URLs while preserving ordinary links', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[bad](javascript:alert%281%29)\n\n[good](https://example.com)\n\n![图](https://example.com/image.png)');
  expect(html).not.toContain('<script>'); expect(html).not.toContain('<img '); expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com"'); expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('图片：图');
});

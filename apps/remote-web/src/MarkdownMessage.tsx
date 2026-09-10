import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

function CodeBlock({ children, text, language }: { children: ReactNode; text: string; language?: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyCode() {
    try { await navigator.clipboard.writeText(text); setCopy('copied'); }
    catch { setCopy('failed'); }
  }
  return <div className="markdown-code">
    <div className="markdown-code-header"><span>{language || '代码'}</span><button type="button" onClick={() => void copyCode()} aria-label="复制代码">{copy === 'copied' ? '已复制' : '复制代码'}</button></div>
    {copy === 'failed' && <span className="markdown-copy-error" role="status">复制未成功，可以长按代码选择文本。</span>}
    <pre tabIndex={0} aria-label={language ? `${language} 代码，可横向滚动` : '代码，可横向滚动'}>{children}</pre>
  </div>;
}
const components: Components = {
  pre({ node, children }) {
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
    const text = code?.type === 'element' ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : '';
    const classes = code?.type === 'element' ? code.properties.className : undefined;
    const language = Array.isArray(classes) ? classes.find(name => String(name).startsWith('language-')) : undefined;
    return <CodeBlock text={text} language={language ? String(language).slice(9) : undefined}>{children}</CodeBlock>;
  },
  table({ node: _node, children, ...props }) {
    return <div className="markdown-table" role="region" aria-label="表格，可横向滚动" tabIndex={0}><table {...props}>{children}</table></div>;
  },
  th({ node: _node, style, ...props }) { return <th {...props} className={`align-${style?.textAlign ?? 'left'}`} />; },
  td({ node: _node, style, ...props }) { return <td {...props} className={`align-${style?.textAlign ?? 'left'}`} />; },
  a({ node: _node, href, children, ...props }) {
    if (!href) return <span>{children}</span>;
    return <a {...props} href={href} {...(!href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>;
  },
  // The remote page only allows its own image assets. Preserve image references as
  // explicit links instead of broken images or automatically fetching third-party URLs.
  img({ src, alt }) { return src ? <a className="markdown-image-link" href={src} target="_blank" rel="noopener noreferrer">图片：{alt || '打开图片'}</a> : <span>{alt}</span>; },
};
const plugins = [remarkGfm];

/** Presentation only: render the original event text without changing stored messages. */
export const MarkdownMessage = memo(function MarkdownMessage({ text, id }: { text: string; id: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={plugins} components={components} remarkRehypeOptions={{ clobberPrefix: `turnwire-${encodeURIComponent(id)}-`, footnoteLabel: '注释', footnoteBackLabel: '返回正文' }}>{text}</ReactMarkdown></div>;
});

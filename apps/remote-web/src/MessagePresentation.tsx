import type { ReactNode } from 'react';
import { CaretRight, TerminalWindow } from '@phosphor-icons/react';
import { MarkdownMessage } from './MarkdownMessage';
import { useLocale } from './i18n';

interface MessageContent { id: string; role: string; text: string; time: string; complete: boolean }
interface ToolContent { tool?: string; input?: string; output?: string; text: string; complete: boolean; isError?: boolean }

/** Shared conversation presentation; callers own attachments, queue state and activity semantics. */
export function MessageBody({ message, lead = true, userLabel, authorLabel, streaming = !message.complete, status, children }: {
  message: MessageContent; lead?: boolean; userLabel?: string; authorLabel?: string; streaming?: boolean; status?: string; children?: ReactNode;
}) {
  const t = useLocale();
  const user = userLabel ?? t('conversation.you');
  return <article className={`message ${message.role}${lead ? '' : ' follow'}`}>
    {lead && <div className="message-author">{message.role === 'user' ? <><span className="avatar">{user}</span>{user}</> : <><img src="/icon-192.png" width="23" height="23" alt="" />{authorLabel ?? 'Turnwire'}</>}<time>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{status && <span className="message-status">{status}</span>}</div>}
    {children}
    <div className="message-text">{message.role === 'assistant' ? <MarkdownMessage text={message.text} id={message.id} /> : message.text}{streaming && <span className="cursor" />}</div>
  </article>;
}

/** The first meaningful line fits a closed tool row. */
function firstLine(value: string) { return value.split('\n').map(line => line.trim()).find(Boolean) ?? ''; }
function toolAction(message: ToolContent) {
  const source = (message.input ?? message.output ?? message.text ?? '').trim();
  if (!source) return '';
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      for (const key of ['command', 'description', 'query', 'pattern', 'path', 'file_path', 'filePath', 'url', 'prompt', 'name']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) return firstLine(value);
      }
      const first = Object.values(parsed).find(value => typeof value === 'string' && value.trim());
      if (typeof first === 'string') return firstLine(first);
    } catch { /* Not JSON: the detail already is the action. */ }
  }
  return firstLine(source);
}
export function ToolHeading({ message }: { message: ToolContent }) {
  const t = useLocale();
  const action = toolAction(message);
  return <><span className="tool-name">{message.tool === 'subagent' ? t('tool.subagentName') : message.tool ?? t('tool.tool')}</span>{action && <span className="tool-action" title={action}>{action}</span>}</>;
}
export function ToolCall({ message, running }: { message: ToolContent; running: boolean }) {
  const t = useLocale();
  return <details className="tool-message"><summary><TerminalWindow size={13} /><ToolHeading message={message} /><span className="tool-status">{message.isError ? t('tool.failed') : message.complete ? t('tool.returned') : t(running ? 'tool.running' : 'tool.noResult')}</span><CaretRight size={11} className="tool-caret" /></summary>{message.input !== undefined && <><strong>{t('tool.input')}</strong><pre>{message.input}</pre></>}{message.output !== undefined && <><strong>{t('tool.output')}</strong><pre>{message.output}</pre></>}</details>;
}

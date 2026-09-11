import type { ConversationMessage } from '@turnwire/sdk';
import type { SubagentView } from '@turnwire/protocol';

/** Only actual launch tools get a durable position, including pending and failed launches. */
export function isChildLaunch(message: ConversationMessage): boolean {
  return message.role === 'tool' && (message.tool === 'subagent' || message.tool === 'subagent_fork');
}

/** Runtime identity, never description, time, list order, or a background job identifier. */
export function launchChild(message: ConversationMessage, scopedChildren: readonly SubagentView[]): SubagentView | undefined {
  if (!isChildLaunch(message) || !message.complete || message.isError) return undefined;
  let id: string | undefined;
  {
    // Foreground output is arbitrary child text, not a launch receipt. Only parse a known
    // background launch's entire receipt; job IDs are deliberately not child IDs.
    try {
      const input: unknown = JSON.parse(message.input ?? '');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
      const scheduling = (input as Record<string, unknown>).run_in_background;
      if (scheduling !== undefined && scheduling !== true) return undefined;
    } catch { return undefined; }
    const receipt = /^started subagent ([^\s]+)$/.exec(message.output ?? '');
    id = receipt?.[0] === message.output ? receipt?.[1] : undefined;
  }
  return id ? scopedChildren.find(child => child.id === id && child.depth === 1) : undefined;
}

export interface ConversationRowData {
  key: string;
  tools?: ConversationMessage[];
  message?: ConversationMessage;
  launch?: ConversationMessage;
  lead: boolean;
}

/** Launch calls interrupt tool runs at their actual journal position, matched or not. */
export function conversationRows(messages: readonly ConversationMessage[]): ConversationRowData[] {
  const rows: ConversationRowData[] = [];
  for (const message of messages) {
    const author = message.role === 'user' ? 'user' : 'assistant';
    const last = rows[rows.length - 1];
    const lastAuthor = last === undefined ? undefined : last.message?.role === 'user' ? 'user' : 'assistant';
    if (isChildLaunch(message)) rows.push({ key: message.id, launch: message, lead: lastAuthor !== author });
    else if (message.role === 'tool' && last?.tools) last.tools.push(message);
    else rows.push({ key: message.id, ...(message.role === 'tool' ? { tools: [message] } : { message }), lead: lastAuthor !== author });
  }
  return rows;
}

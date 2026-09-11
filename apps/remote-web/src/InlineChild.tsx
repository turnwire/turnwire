import { useState, type ReactNode } from 'react';
import type { SubagentView } from '@turnwire/protocol';
import type { TurnwireClient } from '@turnwire/sdk';
import { ChildExecution } from './ChildExecution';
import { useLocale } from './i18n';

/** A launch's permanent transcript entry. Tool return and child activity are independent facts. */
export function InlineChild({ agent, client, sessionId, connected, tool }: { agent?: SubagentView; client?: TurnwireClient; sessionId: string; connected: boolean; tool: ReactNode }) {
  const t = useLocale();
  const [open, setOpen] = useState(false);
  return <section className="inline-child" data-subagent-id={agent?.id}>
    {agent && <>
      <button type="button" className="inline-child-toggle" aria-expanded={open} aria-label={`${t('agents.detailAria', { label: agent.label })} — ${t(open ? 'agents.detailHide' : 'agents.detailShow')}`} onClick={() => setOpen(value => !value)}>
        <span className="agent-dot" data-activity={agent.activity} />
        <strong>{agent.label}</strong>
        <span className="inline-child-activity">{t(agent.activity === 'running' ? 'inlineChild.running' : 'inlineChild.inactive')}</span>
        <span className="agent-caret" aria-hidden="true">›</span>
      </button>
      {open && <ChildExecution key={agent.id} client={client} sessionId={sessionId} subagentId={agent.id} connected={connected} running={agent.activity === 'running'} />}
    </>}
    {tool}
  </section>;
}

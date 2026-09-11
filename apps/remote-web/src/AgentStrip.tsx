import { useState } from 'react';
import type { SubagentView } from '@turnwire/protocol';
import type { TurnwireClient } from '@turnwire/sdk';
import { ChildExecution } from './ChildExecution';
import { t as translate, useLocale } from './i18n';

/** How many rows the strip shows before it offers the rest; a phone must not lose the composer. */
export const MAX_AGENT_ROWS = 3;

/** How long an agent has been working, rounded the way a person reads a stopwatch. */
function duration(ms: number) { const seconds = Math.round(ms / 1000); return seconds < 60 ? translate('agents.seconds', { value: seconds }) : translate('agents.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }); }
/** The step an agent is on, or how far its plan got; the plan is the progress it reports. */
function step(agent: SubagentView) {
  const current = agent.todos.find(todo => todo.status === 'in_progress');
  const done = agent.todos.filter(todo => todo.status === 'completed').length;
  return current ? translate('agents.current', { done, total: agent.todos.length, content: current.content }) : translate('agents.steps', { done, total: agent.todos.length });
}
const todoKey = { pending: 'agents.todoPending', in_progress: 'agents.todoInProgress', completed: 'agents.todoCompleted' } as const;

/**
 * The background agents a session has delegated to. A delegation returns at once, so the transcript
 * goes quiet while children work, and this strip is the only place their progress shows.
 *
 * Expansion reads the child's own execution, never a projection of the parent's journal.
 * Inactive children remain discoverable, and an open child stays visible when it settles.
 */
export function AgentStrip({ agents, client, sessionId, connected }: { agents: SubagentView[]; client?: TurnwireClient; sessionId: string; connected: boolean }) {
  useLocale();
  const [open, setOpen] = useState<string>();
  const [all, setAll] = useState(false);
  const [inactive, setInactive] = useState(false);
  if (agents.length === 0) return null;
  const running = agents.filter(agent => agent.activity === 'running');
  const resting = agents.filter(agent => agent.activity !== 'running');
  // Idle history must not occupy the composer; preserve only an explicitly opened reader.
  if (running.length === 0 && !agents.some(agent => agent.id === open)) return null;
  const shown = [...running.filter((agent, index) => all || index < MAX_AGENT_ROWS || agent.id === open), ...resting.filter(agent => inactive || agent.id === open)];
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  return <div className="agent-strip" role="status" aria-label={translate('agents.aria')}>
    {running.length > 0 && <div className="agent-heading">{translate('agents.running', { count: running.length })}</div>}
    {resting.length > 0 && <button type="button" className="agent-more" aria-expanded={inactive} onClick={() => setInactive(value => !value)}>{translate(inactive ? 'agents.inactiveHide' : 'agents.inactiveShow', { count: resting.length })}</button>}
    <div className="agent-list">{shown.map(agent => {
      const expanded = open === agent.id;
      return <div className="agent-row" key={agent.id}>
        <button type="button" className="agent-item" aria-expanded={expanded} aria-label={`${translate('agents.detailAria', { label: agent.label })} — ${expanded ? translate('agents.detailHide') : translate('agents.detailShow')}`} onClick={() => setOpen(expanded ? undefined : agent.id)}>
          <span className="agent-dot" data-activity={agent.activity} />
          <span className="agent-label">{agent.label}</span>
          {agent.elapsedMs !== undefined && <span className="agent-time">{duration(agent.elapsedMs)}</span>}
          {agent.todos.length > 0 && <span className="agent-steps">{step(agent)}</span>}
          <span className="agent-caret" aria-hidden="true">›</span>
        </button>
        {expanded && <div className="agent-detail">
          <div className="agent-meta">
            <span>{agent.mode === 'continuable' ? translate('agents.modeContinuable') : translate('agents.modeOneShot')}</span>
            {agent.depth > 1 && <span>{byId.has(agent.parentId) ? translate('agents.under', { label: byId.get(agent.parentId)!.label }) : translate('agents.depth', { depth: agent.depth })}</span>}
          </div>
          <ChildExecution key={agent.id} client={client} sessionId={sessionId} subagentId={agent.id} connected={connected} running={agent.activity === 'running'} />
          <details className="agent-secondary-plan"><summary>{translate('agents.plan')}</summary>
          {agent.todos.length === 0 ? <p className="agent-noplan">{translate('agents.noPlan')}</p> : <>
            <div className="agent-plan-title">{translate('agents.plan')}</div>
            <ul className="agent-plan">{agent.todos.map((todo, index) => <li key={`${index}-${todo.content}`} data-status={todo.status}>
              <span className="agent-plan-mark" aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}</span>
              <span className="agent-plan-status">{translate(todoKey[todo.status])}</span>
              <span className="agent-plan-text">{todo.content}</span>
            </li>)}</ul>
          </>}
          </details>
        </div>}
      </div>;
    })}</div>
    {running.length > MAX_AGENT_ROWS && <button type="button" className="agent-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? translate('agents.collapse') : translate('agents.showAll', { count: running.length })}</button>}
  </div>;
}

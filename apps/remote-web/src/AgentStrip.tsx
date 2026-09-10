import { useState } from 'react';
import type { SubagentView } from '@turnwire/protocol';
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
 * A row is a control: the runtime reports each child's own plan, and the full plan is what someone
 * asks for when a child looks stuck — so tapping a row opens that child's details in place rather
 * than sending the reader to another screen. Only running children are listed; what finished is
 * already in the transcript.
 */
export function AgentStrip({ agents }: { agents: SubagentView[] }) {
  useLocale();
  const [open, setOpen] = useState<string>();
  const [all, setAll] = useState(false);
  if (agents.length === 0) return null;
  const shown = all ? agents : agents.slice(0, MAX_AGENT_ROWS);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  return <div className="agent-strip" role="status" aria-label={translate('agents.aria')}>
    <div className="agent-heading">{translate('agents.running', { count: agents.length })}</div>
    {shown.map(agent => {
      const expanded = open === agent.id;
      return <div className="agent-row" key={agent.id}>
        <button type="button" className="agent-item" aria-expanded={expanded} aria-label={`${translate('agents.detailAria', { label: agent.label })} — ${expanded ? translate('agents.detailHide') : translate('agents.detailShow')}`} onClick={() => setOpen(expanded ? undefined : agent.id)}>
          <span className="agent-dot" />
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
          {agent.todos.length === 0 ? <p className="agent-noplan">{translate('agents.noPlan')}</p> : <>
            <div className="agent-plan-title">{translate('agents.plan')}</div>
            <ul className="agent-plan">{agent.todos.map((todo, index) => <li key={`${index}-${todo.content}`} data-status={todo.status}>
              <span className="agent-plan-mark" aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}</span>
              <span className="agent-plan-status">{translate(todoKey[todo.status])}</span>
              <span className="agent-plan-text">{todo.content}</span>
            </li>)}</ul>
          </>}
        </div>}
      </div>;
    })}
    {agents.length > MAX_AGENT_ROWS && <button type="button" className="agent-more" onClick={() => setAll(value => !value)}>{all ? translate('agents.collapse') : translate('agents.showAll', { count: agents.length })}</button>}
  </div>;
}

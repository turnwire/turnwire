import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionContext } from '@turnwire/protocol';
import { t, useLocale } from './i18n';
import { contextUsage } from './contextUsage';
import './context-usage.css';

export function ContextUsage({ context }: { context?: SessionContext }) {
  useLocale();
  const panel = useRef<HTMLDetailsElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const close = () => { panel.current?.removeAttribute('open'); setOpen(false); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !popup.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && panel.current?.open) { close(); panel.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!panel.current || !popup.current) return;
      const anchor = panel.current.getBoundingClientRect(); const box = popup.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      setPosition({ left: Math.max(x + 8, Math.min(anchor.right - box.width, x + width - box.width - 8)), top: Math.max(y + 8, Math.min(anchor.top - box.height - 8, y + height - box.height - 8)) });
    };
    place(); const observer = new ResizeObserver(place); if (popup.current) observer.observe(popup.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [open]);
  const usage = contextUsage(context);
  const label = usage.text === undefined ? t('context.unknown') : `Context ${usage.text}`;
  const detail = usage.text === undefined ? t('context.unknown') : t(usage.estimated ? 'context.estimated' : 'context.reported');
  return <><details ref={panel} className="context-usage" data-known={usage.tokens !== undefined} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title={`${label}. ${detail}`} aria-label={`${label}. ${detail}`}>
      <svg className="context-ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" />{usage.percent !== undefined ? <circle className="context-ring-value" cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${Math.min(100, usage.percent)} 100`} /> : <path className="context-ring-unknown" d="M8 10h4" />}</svg>
    </summary>
  </details>{open && createPortal(<div ref={popup} className="context-detail context-floating" role="region" aria-label="Context" style={position}><strong>{label}</strong><span>{detail}</span><p>{t('context.help')}</p></div>, document.body)}</>;
}

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Check } from '@phosphor-icons/react';
import type { ModelCatalog } from '@turnwire/protocol';
import { carriedEffort, type ModelChoice } from './modelChoice';
import { useLocale } from './i18n';

/** Native buttons keep Tab/Enter/Space available without a second, native select popup. */
export function ModelPicker({ anchor, catalog, current, disabled, pending, error, catalogLoading, catalogError, retryCatalog, choose, children }: {
  anchor: RefObject<HTMLSpanElement | null>; catalog?: ModelCatalog; current?: ModelChoice;
  disabled: boolean; pending: boolean; error: string;
  catalogLoading: boolean; catalogError: string; retryCatalog: () => void;
  choose: (provider: string, model: string, effort?: string) => void; children?: ReactNode;
}) {
  const t = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, bottom: 8, width: 330, maxHeight: 400 });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth; const height = viewport?.height ?? innerHeight;
      const panelWidth = Math.min(330, width - 16);
      const edge = Math.min(rect.top - 9, top + height - 8);
      setPosition({ left: Math.max(left + 8, Math.min(rect.right - panelWidth, left + width - panelWidth - 8)), bottom: innerHeight - edge, width: panelWidth, maxHeight: Math.max(0, edge - top - 8) });
    };
    place(); panel.current?.focus({ preventScroll: true });
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [anchor]);
  const groups = catalog?.groups.filter(group => group.models.length) ?? [];
  const selected = current ?? catalog?.default;
  return <div ref={panel} tabIndex={-1} className="model-picker" style={position} role="dialog" aria-label={t('model.label')} aria-busy={pending || catalogLoading} onKeyDown={event => {
    // Opening the panel must not send the composer draft on Enter.
    if (event.key === 'Enter' && event.target === panel.current) { event.preventDefault(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLSelectElement) return;
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('.model-option:not(:disabled)') ?? []);
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    {catalog ? <>
      <p className="model-default">{t('model.runtimeDefaultNamed', { provider: catalog.default.provider, model: catalog.default.model })}</p>
      <div className="model-list">{groups.map(group => <section key={group.id} aria-label={group.name}>
        <h3>{group.name}</h3>{group.models.map(model => {
          const checked = selected?.provider === group.id && selected.model === model.id;
          const unavailable = !catalog.routableProviders.includes(group.id);
          return <button type="button" className="model-option" key={model.id} data-provider={group.id} data-model={model.id} aria-pressed={checked} disabled={disabled || pending || unavailable} onClick={() => { if (!checked || !current) choose(group.id, model.id, carriedEffort(catalog, current, { provider: group.id, model: model.id })); }}>
            <span>{model.name}<small>{model.id}{unavailable ? t('model.unavailableSuffix') : ''}</small></span>{checked && <Check aria-hidden="true" size={16} />}
          </button>;
        })}
      </section>)}{!groups.length && <p role="status">{t('model.noResults')}</p>}</div>
      {children}
    </> : null}
    {catalogLoading && <p className="model-loading" role="status">{t('model.loadingCatalog')}</p>}
    {catalogError && <div className="model-catalog-failure"><p className="model-error" role="alert">{t('model.catalogFailed')} {catalogError}</p>{catalog && <p className="model-loading">{t('model.catalogStale')}</p>}<button type="button" disabled={catalogLoading} onClick={retryCatalog}>{t('model.catalogRetry')}</button></div>}
    {pending && <p role="status">{t('model.switching')}</p>}
    {error && <p className="model-error" role="alert">{error}</p>}
  </div>;
}

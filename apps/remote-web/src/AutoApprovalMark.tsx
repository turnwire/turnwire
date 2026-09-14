import { useEffect, useRef, useState } from 'react';
import { useLocale } from './i18n';
export function AutoApprovalMark({ enabled }: { enabled: boolean }) {
  const t = useLocale();
  const previous = useRef(enabled);
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    if (previous.current === enabled) return;
    previous.current = enabled; setNotice(true);
    const timer = setTimeout(() => setNotice(false), 2200);
    return () => clearTimeout(timer);
  }, [enabled]);
  return <>{notice && <span className="auto-approval-notice" role="status">{t(enabled ? 'session.autoApproveShortOn' : 'session.autoApproveOff')}</span>}<svg className="auto-approval-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 21 6v6c0 5-5.5 8.5-9 10-3.5-1.5-9-5-9-10V6Z" fill={enabled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m13 6-5 7h4l-1 5 6-8h-4Z" fill={enabled ? '#fff' : 'currentColor'} /></svg>{enabled && <svg className="auto-approval-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" fill="currentColor" /><path d="m3.3 6 1.8 1.8 3.6-3.6" fill="none" stroke="white" strokeWidth="1.4" /></svg>}</>;
}

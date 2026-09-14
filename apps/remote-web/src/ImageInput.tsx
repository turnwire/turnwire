import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { Image as ImageIcon, X } from '@phosphor-icons/react';
import { loadImage, type TurnwireClient } from '@turnwire/sdk';
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGE_TEXT_LENGTH, type ImageInput, type ImageAttachment } from '@turnwire/protocol';
import { t, useLocale, errorText } from './i18n';
import './images.css';

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_BYTES = MAX_IMAGE_BYTES;
export function imageDataUrl(image: Pick<ImageInput, 'mediaType' | 'data'>) { return `data:${image.mediaType};base64,${image.data}`; }
function readData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = () => reject(new Error(t('image.invalid'))); reader.readAsDataURL(file); });
}
/** Preserve small originals (including animation); only PNG/JPEG are re-encoded. */
export async function prepareImage(file: File): Promise<{ image: ImageInput; compressed: boolean }> {
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) throw new Error(t('image.type'));
  if (file.size > 10 * 1024 * 1024) throw new Error(t('image.originalLimit'));
  const data = await readData(file);
  const decoded = new window.Image();
  await new Promise<void>((resolve, reject) => { decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error(t('image.invalid'))); decoded.src = imageDataUrl({ mediaType: file.type as ImageInput['mediaType'], data }); });
  if (decoded.naturalWidth * decoded.naturalHeight > 40_000_000 || Math.max(decoded.naturalWidth, decoded.naturalHeight) > 16384) throw new Error(t('image.dimensions'));
  const image = { mediaType: file.type as ImageInput['mediaType'], data, name: file.name };
  if (file.size <= MAX_BYTES && Math.max(decoded.width, decoded.height) <= 1600) return { image, compressed: false };
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error(t('image.largeAnimated'));
  const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('image.invalid'));
  let scale = Math.min(1, 1600 / Math.max(decoded.width, decoded.height));
  for (let attempt = 0; attempt < 10; attempt++) {
    canvas.width = Math.max(1, Math.round(decoded.width * scale)); canvas.height = Math.max(1, Math.round(decoded.height * scale));
    ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type, 0.82));
    if (blob && blob.size <= MAX_BYTES) return { image: { ...image, data: await readData(blob) }, compressed: true };
    scale *= 0.75;
  }
  throw new Error(t('image.size'));
}

export function useImageDraft(sessionKey: unknown) {
  const context = useRef({ key: sessionKey, generation: 0 });
  if (context.current.key !== sessionKey) context.current = { key: sessionKey, generation: context.current.generation + 1 };
  const [state, setState] = useState<{ context: typeof context.current; images: ImageInput[]; processing: boolean; error: string; notice: string }>({ context: context.current, images: [], processing: false, error: '', notice: '' });
  const current = state.context === context.current ? state : { context: context.current, images: [], processing: false, error: '', notice: '' };
  const latest = useRef(current); latest.current = current;
  const update = (patch: Partial<typeof state>) => { latest.current = { ...latest.current, ...patch }; setState(latest.current); };
  const addFiles = async (files: File[], supported = true) => {
    if (!supported) { update({ error: t('image.unsupported') }); return; }
    if (latest.current.processing) return;
    if (files.length + latest.current.images.length > MAX_IMAGES) { update({ error: t('image.count') }); return; }
    const token = context.current;
    update({ processing: true, error: '' });
    try {
      const prepared = await Promise.all(files.map(prepareImage));
      if (token !== context.current) return;
      update({ images: [...latest.current.images, ...prepared.map(value => value.image)], notice: prepared.some(value => value.compressed) ? t('image.compressed') : latest.current.notice });
    } catch (error) { if (token === context.current) update({ error: errorText(error) }); }
    finally { if (token === context.current) update({ processing: false }); }
  };
  return { ...current, addFiles,
    onPaste: (event: ClipboardEvent, supported = true) => { const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); void addFiles(files, supported); } },
    remove: (index: number) => update({ images: latest.current.images.filter((_, i) => i !== index), error: '' }),
    clear: () => { if (current.context === context.current) update({ images: [], error: '', notice: '' }); },
    validate: (text: string, supported = true) => { const error = latest.current.images.length && !supported ? t('image.unsupported') : latest.current.images.length && text.length > MAX_IMAGE_TEXT_LENGTH ? t('image.textLimit') : ''; update({ error }); return !error && !latest.current.processing; },
  };
}
export function ImagePicker({ draft, disabled, supported, controls }: { draft: ReturnType<typeof useImageDraft>; disabled?: boolean; supported: boolean; controls?: ReactNode }) {
  const t = useLocale(); const input = useRef<HTMLInputElement>(null);
  return <><div className="composer-utility-row">{controls}<button className="image-picker" type="button" aria-label={t('image.add')} title={supported ? t('image.hint') : t('image.unsupported')} disabled={disabled || draft.processing} onClick={() => supported ? input.current?.click() : void draft.addFiles([], false)}><ImageIcon size={20} /></button></div><input ref={input} type="file" hidden multiple accept={IMAGE_ACCEPT} onChange={event => { void draft.addFiles(Array.from(event.target.files ?? []), supported); event.target.value = ''; }} />
    {draft.images.length > 0 && <div className="image-draft-strip">{draft.images.map((image, index) => <div className="image-draft" key={index}><img src={imageDataUrl(image)} alt={image.name || t('image.attachment')} /><button type="button" aria-label={`${t('image.remove')} ${image.name ?? index + 1}`} disabled={disabled || draft.processing} onClick={() => draft.remove(index)}><X size={14} /></button></div>)}<small>{t('image.hint')}</small></div>}
    {draft.processing && <small className="image-feedback" role="status">{t('image.processing')}</small>}{draft.notice && draft.images.length > 0 && <small className="image-feedback" role="status">{draft.notice}</small>}{draft.error && <small className="image-feedback" role="alert">{draft.error}</small>}</>;
}
export function MessageImages({ client, sessionId, images }: { client?: TurnwireClient; sessionId: string; images?: ImageAttachment[] }) {
  return images?.length ? <div className="message-images">{images.map(image => <ReceivedImage key={`${sessionId}:${image.attachmentId}`} client={client} sessionId={sessionId} image={image} />)}</div> : null;
}
function ReceivedImage({ client, sessionId, image }: { client?: TurnwireClient; sessionId: string; image: ImageAttachment }) {
  const t = useLocale(); const element = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(false); const [src, setSrc] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (!element.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; } const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '200px' }); observer.observe(element.current); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!visible || !client) return; let alive = true; setSrc(''); setError(''); void loadImage(client, { sessionId, attachmentId: image.attachmentId }).then(result => { if (alive) setSrc(imageDataUrl({ mediaType: result.attachment.mediaType, data: result.data })); }).catch(() => { if (alive) setError(t('image.loadError')); }); return () => { alive = false; }; }, [client, sessionId, image.attachmentId, visible, attempt, t]);
  return <div ref={element} className="received-image">{src ? <img src={src} alt={image.name || t('image.attachment')} loading="lazy" onError={() => { setSrc(''); setError(t('image.loadError')); }} /> : <span>{image.name || t('image.attachment')} · {Math.ceil(image.bytes / 1024)} KiB</span>}{error && <button type="button" onClick={() => setAttempt(value => value + 1)}>{error}</button>}</div>;
}

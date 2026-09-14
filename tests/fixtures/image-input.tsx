import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImagePicker, MessageImages, useImageDraft } from '../../apps/remote-web/src/ImageInput';
import '../../apps/remote-web/src/style.css';
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6R9sAAAAASUVORK5CYII=';
const attachment = { attachmentId: 'fixture-image', mediaType: 'image/png' as const, bytes: atob(data).length, width: 1, height: 1, name: 'Received image' };
const fixture = { calls: [] as any[], fail: false, delay: 0 };
Object.assign(window, { fixture });
const client = { async call(method: string, args: any) { fixture.calls.push({ method, ...args }); await new Promise(resolve => setTimeout(resolve, fixture.delay)); if (fixture.fail) throw new Error('Fixture RPC failure'); return method === 'session.image' ? { attachment, data, offset: 0, nextOffset: null } : {}; } };
function Fixture() {
  const [session, setSession] = useState('one'); const context = useRef(session); context.current = session;
  const draft = useImageDraft(session); const [text, setText] = useState(''); const [error, setError] = useState(''); const [received, setReceived] = useState(false); const [supported, setSupported] = useState(true);
  return <main style={{ width: 360, padding: 12 }}><button onClick={() => { setSession(session === 'one' ? 'two' : 'one'); setText(''); }}>Switch session</button><button onClick={() => setReceived(true)}>Show received</button><button onClick={() => setSupported(false)}>Unsupported runtime</button><output>{session}</output><form className="composer" onSubmit={event => { event.preventDefault(); if ((!text.trim() && !draft.images.length) || !draft.validate(text, supported)) return; const token = session; void client.call('session.message', { sessionId: session, text, images: draft.images }).then(() => { if (token === context.current) { draft.clear(); setText(''); setError(''); } }).catch(error => setError(error.message)); }}><ImagePicker draft={draft} supported={supported} /><textarea aria-label="Message" value={text} onChange={event => setText(event.target.value)} onPaste={event => draft.onPaste(event, supported)} /><button type="submit" disabled={draft.processing}>Send</button></form>{error && <p role="alert">{error}</p>}{received && <MessageImages client={client as any} sessionId={session} images={[attachment]} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

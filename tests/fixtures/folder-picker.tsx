import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, WorkspaceListing } from '@turnwire/protocol';
import { CreateSession } from '../../apps/remote-web/src/App';
import '../../apps/remote-web/src/style.css';
const fixture = { calls: [] as { parent: string; name: string }[], fail: false, delay: 0, sessions: [] as string[] };
Object.assign(window, { fixture });
const listing = (path = '/host/home'): WorkspaceListing => ({ path, home: '/host/home', parent: '/host', entries: [], total: 0 });
const snapshot = { sessions: [], runtimes: [{ id: 'fixture', name: 'Fixture', online: true }] } as unknown as Snapshot;
createRoot(document.getElementById('root')!).render(<CreateSession snapshot={snapshot} busy={false} close={() => {}} onBrowse={async path => listing(path)} onCreateDirectory={async (parent, name) => {
  fixture.calls.push({ parent, name });
  await new Promise(resolve => setTimeout(resolve, fixture.delay));
  if (fixture.fail) throw new Error('Directory already exists');
  return listing(`${parent}/${name}`);
}} onCreate={cwd => fixture.sessions.push(cwd)} />);

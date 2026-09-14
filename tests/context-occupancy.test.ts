import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DshRuntime } from '@turnwire/runtime-dsh';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextProjection } from '../packages/runtime-dsh/src/context.js';
import { showContext } from '../apps/cli/src/context.js';
import { setLocale } from '../apps/cli/src/i18n.js';
import { sessionContextSchema, type Session } from '@turnwire/protocol';
import { Store, TurnwireCore } from '@turnwire/core';
import { DemoRuntime, type RuntimeEvent } from '@turnwire/runtime';
import { applyEvent, LocalClient, RemoteClient } from '@turnwire/sdk';
import type { TurnwireEvent } from '@turnwire/protocol';
import { randomSecret } from '@turnwire/wire';
import { startDaemonServer } from '../apps/daemon/src/server.js';
import { startRelay } from '../apps/relay/src/server.js';
import { RemoteBridge } from '../apps/daemon/src/remote.js';

it('reads the real mux control contract and clears on disconnect without stale follow revival', async () => {
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': 'dsh_auth=test' }); res.end(); }
    else if (req.method === 'POST' && req.url === '/api/session/list' && req.headers.cookie === 'dsh_auth=test') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      expect(request).toMatchObject({ type: 'client-request', method: 'session/list', payload: { args: { _request: {} } } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [{ sessionId: 's', running: false }] } } }));
    } else { res.writeHead(404); res.end(); }
  });
  const sockets = new WebSocketServer({ server });
  let socket: WebSocket | undefined; let follow: string | undefined;
  const send = (streamId: string, value: unknown) => socket!.send(JSON.stringify({ type: 'item', streamId, value }));
  sockets.on('connection', peer => {
    socket = peer;
    peer.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.endpoint === '$events') send('events', { type: 'ready', clientId: 'generation' });
      if (frame.endpoint === 'session/control') {
        expect(frame.payload.args).toEqual({});
        send(frame.streamId, { type: 'baseline', value: { queues: {}, jobs: {}, projections: { s: { asOfSeq: 10, values: { contextPressure: { contextWindow: 1000, pressureTokens: 250 } } } } } });
      }
      if (frame.endpoint === 'session/follow') follow = frame.streamId;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = new DshRuntime({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'test' });
  const events: RuntimeEvent[] = []; runtime.subscribe('s', event => events.push(event));
  try {
    expect((await runtime.health()).online).toBe(true);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'context', context: { contextWindow: 1000, pressureTokens: 250 } }));
    send('context-control', { type: 'projection', sessionId: 's', key: 'contextPressure', seq: 11, value: { pressureTokens: 300 } });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'context', context: { pressureTokens: 300 } }));
    socket!.send(JSON.stringify({ type: 'end', streamId: 'context-control' }));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'context' }));
    expect(follow).toBeDefined();
    socket!.close();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'status', status: 'interrupted' }));
    expect(events.filter(event => event.type === 'context').at(-1)).toEqual({ type: 'context' });
  } finally {
    await runtime.dispose();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('preserves context snapshots and updates across local and encrypted paired transports', async () => {
  const runtime = new DemoRuntime();
  let emit: ((event: RuntimeEvent) => void) | undefined;
  vi.spyOn(runtime, 'subscribe').mockImplementation((_id, listener) => { emit = listener; return () => {}; });
  const core = new TurnwireCore(new Store(':memory:'), [runtime], { id: 'host', name: 'Host' });
  const token = randomSecret(); const server = await startDaemonServer({ core, token, port: 0 });
  const local = new LocalClient(`http://127.0.0.1:${server.port}`, token);
  const relayToken = randomSecret(); const relay = await startRelay({ token: relayToken, port: 0 });
  const pairing = { v: 2 as const, hostId: 'host', clientId: 'context-phone', name: 'Phone', relayUrl: `ws://127.0.0.1:${relay.port}`, token: randomSecret(), key: randomSecret() };
  core.store.addDevice(pairing);
  const bridge = new RemoteBridge(core, pairing.relayUrl, relayToken); bridge.start();
  const remote = new RemoteClient(pairing);
  const unsubs: Array<() => void> = [];
  try {
    await vi.waitFor(() => expect(bridge.connected).toBe(true));
    const session = await local.call('session.create', { runtimeId: 'demo', title: 'Context parity', cwd: process.cwd() });
    const initial = { contextWindow: 1000, pressureTokens: 400, projectedTokens: 450 };
    emit!({ type: 'context', context: initial });
    const localSnapshot = await local.call('system.snapshot', {});
    const remoteSnapshot = await remote.call('system.snapshot', {});
    expect(localSnapshot.sessions.find(row => row.id === session.id)?.context).toEqual(initial);
    expect(remoteSnapshot.sessions).toEqual(localSnapshot.sessions);
    const localEvents: TurnwireEvent[] = [], remoteEvents: TurnwireEvent[] = [];
    unsubs.push(local.subscribe(event => localEvents.push(event), undefined, localSnapshot.cursor));
    unsubs.push(remote.subscribe(event => remoteEvents.push(event), undefined, remoteSnapshot.cursor));
    const updated = { contextWindow: 1000, pressureTokens: 400, projectedTokens: 200 };
    emit!({ type: 'context', context: updated });
    const updates = (events: TurnwireEvent[]) => events.filter(event => event.data.type === 'session.updated' && event.data.session.id === session.id);
    await vi.waitFor(() => {
      expect(updates(localEvents).map(event => event.data)).toContainEqual({ type: 'session.updated', session: expect.objectContaining({ context: updated }) });
      expect(updates(remoteEvents).map(event => event.data)).toContainEqual({ type: 'session.updated', session: expect.objectContaining({ context: updated }) });
    });
    emit!({ type: 'context' });
    await vi.waitFor(() => {
      for (const events of [localEvents, remoteEvents]) {
        const latest = updates(events).at(-1)?.data;
        expect(latest?.type).toBe('session.updated');
        if (latest?.type === 'session.updated') expect(latest.session.context).toBeUndefined();
      }
    });
    expect((await remote.call('system.snapshot', {})).sessions.find(row => row.id === session.id)?.context).toBeUndefined();
  } finally {
    for (const unsubscribe of unsubs) unsubscribe();
    remote.close(); local.close(); await bridge.close(); await relay.close(); await server.close(); await core.dispose();
  }
});

it('maps exact projection baseline and live watermarks, never usage totals or stale baselines', () => {
  const publish = vi.fn(); const meter = new ContextProjection(publish);
  meter.frame({ type: 'baseline', value: { projections: { s: { asOfSeq: 4, values: { contextPressure: { contextWindow: 1000, pressureTokens: 400, projectedTokens: 450 }, tokenUsage: { inputTokens: 99999 } } } } } });
  expect(meter.current('s')).toEqual({ contextWindow: 1000, pressureTokens: 400, projectedTokens: 450 });
  meter.frame({ type: 'projection', sessionId: 's', key: 'contextPressure', seq: 6, value: { contextWindow: 1000, pressureTokens: 400, projectedTokens: 200 } });
  meter.baseline('s', { asOfSeq: 5, values: { contextPressure: { pressureTokens: 800 } } });
  expect(meter.current('s')?.projectedTokens).toBe(200);
  meter.update('s', 6, { pressureTokens: 900 });
  expect(publish).toHaveBeenCalledTimes(2);
  meter.update('s', 7, {}); expect(meter.current('s')).toBeUndefined();
  meter.reset(); meter.update('s', 1, { pressureTokens: 0 });
  expect(meter.current('s')).toEqual({ pressureTokens: 0 });
});

it('rejects invalid values and preserves unknown versus genuine zero', () => {
  for (const value of [{ pressureTokens: -1 }, { projectedTokens: Infinity }, { contextWindow: 0 }, { contextWindow: NaN }]) expect(sessionContextSchema.safeParse(value).success).toBe(false);
  setLocale('en'); expect(showContext()).toBe('Context: unknown / unknown');
  expect(showContext({ pressureTokens: 0, contextWindow: 1000 })).toBe('Context: 0 / 1000 (0%)');
  expect(showContext({ pressureTokens: 800, projectedTokens: 1200, contextWindow: 1000 })).toBe('Context: 1200 / 1000 (120%) · estimated');
  expect(showContext({ pressureTokens: 400 })).toBe('Context: 400 / unknown');
  setLocale('zh'); expect(showContext()).toBe('上下文: 未知 / 未知'); setLocale('en');
});

it('propagates runtime context to snapshots and SDK, clears disconnect and restart observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'turnwire-context-'));
  const path = join(directory, 'state.db'); const runtime = new DemoRuntime();
  let listener: ((event: RuntimeEvent) => void) | undefined;
  vi.spyOn(runtime, 'subscribe').mockImplementation((_id, next) => { listener = next; return () => {}; });
  const core = new TurnwireCore(new Store(path), [runtime], { id: 'host', name: 'Host' });
  try {
    const response = await core.handle({ v: 1, id: 'create-context', method: 'session.create', params: { cwd: process.cwd(), runtimeId: 'demo' } });
    expect(response.ok).toBe(true); const session = (response as { result: Session }).result;
    let snapshot = await core.snapshot();
    const off = core.subscribe(event => { snapshot = applyEvent(snapshot, event); });
    listener!({ type: 'context', context: { pressureTokens: 300, contextWindow: 1000 } });
    expect((await core.snapshot()).sessions[0]?.context).toEqual({ pressureTokens: 300, contextWindow: 1000 });
    expect(snapshot.sessions[0]?.context?.pressureTokens).toBe(300);
    listener!({ type: 'context' }); expect(snapshot.sessions[0]?.context).toBeUndefined();
    listener!({ type: 'context', context: { pressureTokens: 500 } });
    off(); await core.dispose();
    const second = new TurnwireCore(new Store(path), [new DemoRuntime()], { id: 'host', name: 'Host' });
    try { expect((await second.snapshot()).sessions.find(row => row.id === session.id)?.context).toBeUndefined(); } finally { await second.dispose(); }
  } finally { await core.dispose(); await rm(directory, { recursive: true, force: true }); }
});

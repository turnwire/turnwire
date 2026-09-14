import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { RelayPush } from '../apps/relay/src/push.js';
import { startRelay } from '../apps/relay/src/server.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function database(push: RelayPush) { return (push as unknown as {db:DatabaseSync}).db; }
function enqueue(push: RelayPush) {
  const db = database(push);
  db.prepare('INSERT INTO subscriptions VALUES(?,?,?)').run('host','phone',JSON.stringify({endpoint:'https://web.push.apple.com/test',keys:{auth:'x',p256dh:'y'}}));
  db.prepare('INSERT INTO notifications(host,client,id,expires,retry) VALUES(?,?,?,?,?)').run('host','phone','one',Date.now()+100000,0);
}
it('owns timer query errors, exposes health, permits recovery, and seals all DB admission', async () => {
  vi.useFakeTimers(); const push = new RelayPush(':memory:','https://relay.example'); const db = database(push);
  const error = new Error('SQLITE_IOERR'); const prepare = vi.spyOn(db,'prepare').mockImplementationOnce(() => {throw error;});
  await vi.advanceTimersByTimeAsync(1000); expect(push.health).toEqual({status:'error',error});
  prepare.mockRestore(); await push.flush(); expect(push.health.status).toBe('ok');
  await push.close(); expect(vi.getTimerCount()).toBe(0);
  expect(()=>push.handle('host',new Set(),{})).toThrow('closing'); expect(()=>push.reconcile('host',[])).toThrow('closing');
  await expect(push.flush()).rejects.toThrow('closing'); expect(()=>db.prepare('SELECT 1')).toThrow();
});
for (const mode of ['delivery-update','retry-update','json'] as const) it(`preserves ${mode} failures while close still releases SQLite`, async () => {
  const deliver = mode === 'retry-update' ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn().mockResolvedValue({});
  const push = new RelayPush(':memory:','https://relay.example',deliver); enqueue(push); const db = database(push);
  if(mode==='json') db.exec("UPDATE subscriptions SET body='invalid json'");
  else db.exec(`CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(FAIL,'SQLITE_IOERR ${mode}'); END`);
  const error = await push.flush().catch(e=>e); expect(error).toBeInstanceOf(Error); expect(push.health.status).toBe('error');
  const close = push.close(); expect(push.close()).toBe(close); await expect(close).rejects.toBe(error);
  expect(()=>db.prepare('SELECT 1')).toThrow();
});
it('close drains delivery before closing DB even if its final update fails', async () => {
  let finish!:()=>void; const delivery = new Promise<void>(resolve=>{finish=resolve;});
  const push = new RelayPush(':memory:','https://relay.example',vi.fn().mockImplementation(()=>delivery)); enqueue(push); const db=database(push);
  db.exec("CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(FAIL,'SQLITE_IOERR'); END");
  const flushing=push.flush().catch(e=>e); const close=push.close(); const observed=close.catch(e=>e);
  expect(db.prepare('SELECT 1').get()).toBeDefined(); finish(); expect(await observed).toBe(await flushing); expect(()=>db.prepare('SELECT 1')).toThrow();
});
it('reports scheduled push faults through HTTP health and closes network despite push failure', async () => {
  const relay=await startRelay({token:'t'.repeat(64),port:0,push:{path:':memory:',subject:'https://relay.example'}});
  const fault=new Error('SQLITE_IOERR'); const prepare=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(()=>{throw fault;});
  await expect.poll(async()=> (await fetch(`http://127.0.0.1:${relay.port}/health`)).status,{timeout:3000}).toBe(503);
  prepare.mockRestore(); const close=relay.close(); expect(relay.close()).toBe(close); await expect(close).rejects.toBe(fault);
  await expect(fetch(`http://127.0.0.1:${relay.port}/health`)).rejects.toThrow();
});

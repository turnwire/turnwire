import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { LocalClient } from '@turnwire/sdk';
import { createProgram } from '../apps/cli/src/program.js';
import { runTui } from '../apps/cli/src/terminal.js';

const listing = { path: '/host/home/new folder', parent: '/host/home', home: '/host/home', entries: [], total: 0 };
function setup() {
  const request = vi.spyOn(LocalClient.prototype, 'request').mockResolvedValue(listing);
  const close = vi.spyOn(LocalClient.prototype, 'close').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dispatch = (args: string[]) => createProgram({ url: 'http://localhost:1', token: 'test', json: true, lang: 'en' }).parseAsync(args, { from: 'user' });
  return { request, close, log, dispatch };
}
afterEach(() => vi.restoreAllMocks());
it('preserves dirs listing and resolves explicit paths', async () => {
  const { request, dispatch } = setup();
  await dispatch(['dirs', '.']);
  expect(request).toHaveBeenCalledWith('workspace.list', { path: resolve('.') });
});
it('creates one host directory through the SDK and prints the returned listing', async () => {
  const { request, close, log, dispatch } = setup();
  await dispatch(['dirs', '/host/home', '--mkdir', 'new folder']);
  expect(request).toHaveBeenCalledExactlyOnceWith('workspace.mkdir', { parent: '/host/home', name: 'new folder' });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(listing);
  expect(close).toHaveBeenCalledOnce();
});
it('uses host home, not local cwd, when mkdir omits a parent', async () => {
  const { request, dispatch } = setup();
  request.mockResolvedValueOnce({ ...listing, path: '/host/home' });
  await dispatch(['dirs', '--mkdir', 'new folder']);
  expect(request).toHaveBeenNthCalledWith(1, 'workspace.list', {});
  expect(request).toHaveBeenNthCalledWith(2, 'workspace.mkdir', { parent: '/host/home', name: 'new folder' });
});
it('preserves host errors and closes the client on failed creation', async () => {
  const { request, close, dispatch } = setup();
  request.mockRejectedValue(new Error('Directory already exists'));
  await expect(dispatch(['dirs', '/host/home', '--mkdir', 'existing'])).rejects.toThrow('Directory already exists');
  expect(close).toHaveBeenCalledOnce();
});
it('supports quoted directory names through the shared TUI dispatcher', async () => {
  const { request, dispatch } = setup();
  const lines = ['dirs /host/home --mkdir "new folder"', 'quit'];
  await runTui(dispatch, '', { ask: async () => lines.shift(), write: () => {} });
  expect(request).toHaveBeenCalledWith('workspace.mkdir', { parent: '/host/home', name: 'new folder' });
});

export function validateEndpoint(value: string, websocket = false): URL {
  const url = new URL(value);
  if (!(websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password) throw new Error('Invalid connection URL');
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote connections require HTTPS / WSS');
  return url;
}

#!/usr/bin/env node
import { startRelay } from './server.js';
const relay = await startRelay({ token: process.env.TURNWIRE_RELAY_TOKEN ?? '', port: Number(process.env.PORT ?? 9899), host: process.env.TURNWIRE_RELAY_HOST ?? '127.0.0.1', webRoot: process.env.TURNWIRE_REMOTE_WEB_ROOT, ...(process.env.TURNWIRE_PUSH_DB && process.env.TURNWIRE_VAPID_SUBJECT ? { push: { path: process.env.TURNWIRE_PUSH_DB, subject: process.env.TURNWIRE_VAPID_SUBJECT } } : {}) });
console.log(`Turnwire Relay listening on port ${relay.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });

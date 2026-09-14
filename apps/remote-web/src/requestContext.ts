import type { Session, Snapshot } from '@turnwire/protocol';

/** A connection generation and a per-channel owner gate every continuation, including cleanup. */
export class RequestContext {
  private generation = 0;
  private owners = new Map<string, object>();
  reset() { this.generation++; this.owners.clear(); }
  begin(channel: string) {
    const generation = this.generation; const owner = {};
    this.owners.set(channel, owner);
    return () => this.generation === generation && this.owners.get(channel) === owner;
  }
}

/** Action replies are not revisioned: only patch the exact entity observed at dispatch. */
export function mergeModelReply(snapshot: Snapshot | undefined, target: Session, reply: Session): Snapshot | undefined {
  return snapshot ? { ...snapshot, sessions: snapshot.sessions.map(item => item === target ? { ...item, model: reply.model } : item) } : snapshot;
}

/** A create event may already have inserted (and advanced) this session. Never replace it. */
export function mergeCreateReply(snapshot: Snapshot | undefined, reply: Session): Snapshot | undefined {
  return !snapshot || snapshot.sessions.some(item => item.id === reply.id) ? snapshot : { ...snapshot, sessions: [reply, ...snapshot.sessions] };
}

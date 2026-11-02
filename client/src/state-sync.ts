import type { AppState } from './types';
import { terminalSocket } from './ws-client';

type StateListener = (state: AppState, revision: number) => void;

let revision = -1;
let listener: StateListener | null = null;
let unsub: (() => void) | null = null;

export function initStateSync(onState: StateListener): void {
  listener = onState;
  if (unsub) unsub();
  unsub = terminalSocket.onMessage((msg) => {
    if (msg.type !== 'state') return;
    const body = msg as { state?: AppState; revision?: number };
    if (!body.state || typeof body.revision !== 'number') return;
    if (body.revision < revision) return;
    revision = body.revision;
    listener?.(body.state, body.revision);
  });
}

export function pushState(state: AppState): void {
  terminalSocket.pushState(state, revision);
}

export function getLocalRevision(): number {
  return revision;
}

export function markRevision(rev: number): void {
  revision = rev;
}

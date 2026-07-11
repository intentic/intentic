import type { PresenceReport, PresenceUser } from "@intentic/sandbox-contract";
import type { VerifiedIdentity } from "../auth/auth.js";

// Who's connected right now, keyed by per-connection clientId. Ephemeral by design: an entry lives exactly as
// long as its /events connection — registered when the stream starts, removed in its finally — so the roster
// needs no persistence, no timestamps, and no TTL sweep (a dead connection's next heartbeat write fails and
// aborts the stream within seconds).
// ponytail: no TTL sweep — heartbeat write failure unregisters within ~2s; add report-age expiry only if a
//           tunnel ever black-holes writes without erroring.
const entries = new Map<string, PresenceUser>();
const listeners = new Set<(users: PresenceUser[]) => void>();

// Every change broadcasts the FULL roster: snapshots are tiny at member scale and make reconnects self-healing
// (last frame wins — no diff reconciliation, no ordering).
const broadcast = (): void => {
    const users = [...entries.values()];
    for (const listener of listeners) {
        listener(users);
    }
};

export const registerPresence = (clientId: string, identity: VerifiedIdentity): (() => void) => {
    entries.set(clientId, {
        clientId,
        email: identity.email,
        idle: false,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
        ...(identity.picture !== undefined ? { picture: identity.picture } : {}),
    });
    broadcast();
    return () => {
        entries.delete(clientId);
        broadcast();
    };
};

// Full-replace of the activity fields (absent = cleared). Guards: an unknown clientId (the report raced a
// reconnect) is dropped — the tab re-reports after its new stream opens; a clientId owned by another member's
// connection is dropped too, so a member can never repaint someone else's state.
export const updatePresence = (identity: VerifiedIdentity, report: PresenceReport): void => {
    const entry = entries.get(report.clientId);
    if (entry === undefined || entry.email !== identity.email) {
        return;
    }
    entries.set(report.clientId, {
        clientId: entry.clientId,
        email: entry.email,
        idle: report.idle,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.picture !== undefined ? { picture: entry.picture } : {}),
        ...(report.view !== undefined ? { view: report.view } : {}),
        ...(report.sessionId !== undefined ? { sessionId: report.sessionId } : {}),
        ...(report.path !== undefined ? { path: report.path } : {}),
    });
    broadcast();
};

// Immediate snapshot on subscribe, so a fresh /events connection paints the roster without waiting for the
// next change.
export const subscribePresence = (listener: (users: PresenceUser[]) => void): (() => void) => {
    listeners.add(listener);
    listener([...entries.values()]);
    return () => listeners.delete(listener);
};

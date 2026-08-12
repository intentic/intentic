import type { PresenceReport, PresenceUser } from "@intentic/sandbox-contract";
import type { Caller, VerifiedIdentity } from "../auth/auth.js";

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

export const registerPresence = (clientId: string, identity: Caller): (() => void) => {
    entries.set(clientId, {
        clientId,
        email: identity.email,
        role: identity.role,
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
        role: entry.role,
        idle: report.idle,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.picture !== undefined ? { picture: entry.picture } : {}),
        ...(report.view !== undefined ? { view: report.view } : {}),
        ...(report.sessionId !== undefined ? { sessionId: report.sessionId } : {}),
        ...(report.path !== undefined ? { path: report.path } : {}),
    });
    broadcast();
};

// True when nobody is actively watching this sandbox: either no one is connected at all, or every connected
// tab has reported itself idle. This is the gate on push notifications — telling someone their turn finished
// while they sit watching it finish is noise, and the roster is exactly the fact needed to avoid it.
//
// Note it is a whole-sandbox verdict, not a per-recipient one: a subscription is a browser, and the daemon
// has no way to match a push endpoint back to a presence entry (the endpoint is minted by the push service,
// never by us). With members, one collaborator being present therefore suppresses everyone's notification —
// the conservative direction, and the shared-sandbox case is rare enough not to warrant guessing.
export const idleEverywhere = (): boolean => [...entries.values()].every((user) => user.idle);

// How many tabs hold a live /events connection right now. The idle-stop verdict's first question — and
// deliberately NOT idleEverywhere: a tab that reported itself idle is still a person who left the workspace
// open and expects it alive when they come back to the window.
export const connectedCount = (): number => entries.size;

// Immediate snapshot on subscribe, so a fresh /events connection paints the roster without waiting for the
// next change.
export const subscribePresence = (listener: (users: PresenceUser[]) => void): (() => void) => {
    listeners.add(listener);
    listener([...entries.values()]);
    return () => listeners.delete(listener);
};

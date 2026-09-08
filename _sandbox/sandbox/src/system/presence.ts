import type { PresenceReport, PresenceUser } from "@intentic/sandbox-contract";
import type { Caller, VerifiedIdentity } from "../auth/auth.js";

// Live connections keyed by clientId, removed in the stream's finally; no TTL sweep needed.
const entries = new Map<string, PresenceUser>();
const listeners = new Set<(users: PresenceUser[]) => void>();

// Broadcasts the full roster on every change; snapshots are small enough that reconnects just take the latest frame, no
// diffing.
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

// Replaces the activity fields whole (absent clears them). Drops an unknown clientId (a stale report racing reconnect)
// and one owned by another member's connection, so nobody can repaint someone else's state.
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

// True when nobody is watching, gating push notifications. A whole-sandbox verdict: the daemon can't match a push
// endpoint to a presence entry, so one present member suppresses everyone's notification.
export const idleEverywhere = (): boolean => [...entries.values()].every((user) => user.idle);

// Live /events connections, not idleEverywhere: an idle tab is still a person who expects the workspace to stay alive.
export const connectedCount = (): number => entries.size;

// Immediate snapshot on subscribe, so a fresh /events connection paints the roster without waiting for the next change.
export const subscribePresence = (listener: (users: PresenceUser[]) => void): (() => void) => {
    listeners.add(listener);
    listener([...entries.values()]);
    return () => listeners.delete(listener);
};

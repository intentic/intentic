import { createReplayWindow, type RandomBytes, type ReplayWindow, type SessionKey } from "@intentic/sandbox-contract/s2s";
import { S2S_SESSION_TTL_MS } from "@intentic/sandbox-contract/schemas/s2s";

// THE CALLEE'S SESSIONS (docs/architecture/messages.md, "Calls"): in memory only, each for S2S_SESSION_TTL_MS, at most
// SESSIONS_PER_CONTACT a contact (the oldest goes first: a caller keeps one per contact, so more is a restart's or a
// race's), with its own window of call nonces, and one window of session request nonces for every contact. A restart
// forgets them all, which a caller meets as a `session` refusal and opens a new one.

const SESSIONS_PER_CONTACT = 8;

export interface HeldSession {
    readonly id: string;
    readonly key: SessionKey;
    readonly contact: string;
    // The contact's key that signed the request: the session ends once the contact's pinned key is another.
    readonly callerFp: string;
    readonly expiresAt: number;
    readonly replay: ReplayWindow;
}

export interface CallSessions {
    // A session opened now, past the limit dropping the contact's oldest.
    readonly add: (opened: Pick<HeldSession, "key" | "contact" | "callerFp">, random: RandomBytes) => HeldSession;
    readonly get: (id: string) => HeldSession | undefined;
    readonly drop: (id: string) => void;
    readonly clear: () => void;
    readonly size: () => number;
    // Whether a session request's nonce was seen (or its time is outside the window); remembers it when not.
    readonly requestSeen: (nonce: string, at: number) => boolean;
}

export const callSessions = (now: () => number): CallSessions => {
    const held = new Map<string, HeldSession>();
    const requests = createReplayWindow();
    const prune = (): void => {
        const at = now();
        for (const [id, session] of held) {
            if (session.expiresAt <= at) {
                held.delete(id);
            }
        }
    };
    return {
        add: (opened, random) => {
            prune();
            const theirs = [...held.values()].filter((each) => each.contact === opened.contact);
            // Oldest first, as the map keeps them.
            for (const old of theirs.slice(0, Math.max(0, theirs.length - SESSIONS_PER_CONTACT + 1))) {
                held.delete(old.id);
            }
            const session: HeldSession = { ...opened, id: `cs-${Buffer.from(random(16)).toString("hex")}`, expiresAt: now() + S2S_SESSION_TTL_MS, replay: createReplayWindow() };
            held.set(session.id, session);
            return session;
        },
        get: (id) => {
            prune();
            return held.get(id);
        },
        drop: (id) => {
            held.delete(id);
        },
        clear: () => held.clear(),
        size: () => {
            prune();
            return held.size;
        },
        requestSeen: (nonce, at) => requests.admit(nonce, at, now()) !== "fresh",
    };
};

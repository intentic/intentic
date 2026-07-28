import { beforeEach, describe, expect, it } from "vitest";

/* The reader's contract: whatever is on disk, what comes back is a strip that can actually be rendered — every
 * tab named once, a focus that names one of them, and nothing dropped that was still readable. The strip keys
 * its v-for on the conversationId, so a duplicate would be two tabs sharing a key: Vue then patches the wrong
 * node, which reads as the wrong name on a tab, a click that surfaces someone else's chat, and a × that
 * removes neither. */

// The node test environment has neither storage.
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const { readTabSnapshot, writeTabSnapshot } = await import("./tabSnapshot");

const KEY = `intentic.chatTabs.sb1`;
const tab = (conversationId: string, title?: string): Record<string, unknown> => ({
    conversationId,
    isolated: true,
    draft: ``,
    attachments: [],
    queued: [],
    ...(title !== undefined ? { title } : {}),
});
const blob = (active: string, tabs: Record<string, unknown>[]): string => JSON.stringify({ active, tabs });

beforeEach(() => {
    local.clear();
    session.clear();
});

describe(`reading a tab snapshot`, () => {
    it(`prefers this window's own tabs over the seed the last window left`, () => {
        local.set(KEY, blob(`other`, [tab(`other`, `Another window's chat`)]));
        session.set(KEY, blob(`mine`, [tab(`mine`, `This window's chat`)]));

        expect(readTabSnapshot(`sb1`)?.tabs.map((entry) => entry.conversationId)).toEqual([`mine`]);
    });

    it(`falls back to the seed for a window that has never opened this sandbox`, () => {
        local.set(KEY, blob(`a`, [tab(`a`), tab(`b`)]));

        expect(readTabSnapshot(`sb1`)?.tabs).toHaveLength(2);
    });

    it(`has nothing for a sandbox with no snapshot at all, and none for an unbound sandbox`, () => {
        expect(readTabSnapshot(`sb1`)).toBeUndefined();
        expect(readTabSnapshot(undefined)).toBeUndefined();
    });

    it(`collapses a conversation that appears twice into one tab`, () => {
        session.set(KEY, blob(`a`, [tab(`a`, `First`), tab(`b`), tab(`a`, `Same conversation again`)]));

        const snapshot = readTabSnapshot(`sb1`);
        expect(snapshot?.tabs.map((entry) => entry.conversationId)).toEqual([`a`, `b`]);
        expect(snapshot?.tabs[0]?.title).toBe(`First`);
    });

    it(`skips an unreadable entry and keeps the rest`, () => {
        // No conversationId names nothing; a missing draft is not a tab the composer can bind to. Losing the
        // whole strip over one of them is the harsher failure, so only the entry goes.
        session.set(KEY, blob(`b`, [{ draft: `` }, tab(`b`), { conversationId: `c` }]));

        expect(readTabSnapshot(`sb1`)?.tabs.map((entry) => entry.conversationId)).toEqual([`b`]);
    });

    it(`points the focus at the first tab when the stored one names nothing`, () => {
        session.set(KEY, blob(`gone`, [tab(`a`), tab(`b`)]));

        expect(readTabSnapshot(`sb1`)?.active).toBe(`a`);
    });

    it(`degrades an unparseable or empty blob to no snapshot — a fresh tab, not a broken strip`, () => {
        session.set(KEY, `not json`);
        expect(readTabSnapshot(`sb1`)).toBeUndefined();

        session.set(KEY, blob(`a`, []));
        expect(readTabSnapshot(`sb1`)).toBeUndefined();
    });

    it(`restores the fields a tab carries, defaulting an unstated tree to isolated`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [
                    {
                        conversationId: `a`,
                        draft: `half a sentence`,
                        provider: `codex`,
                        harness: `claude-code`,
                        session: { id: `sess-1`, provider: `codex` },
                        title: `Fix the login handler`,
                        attachments: [{ name: `pic.png`, path: `.intentic/attachments/u1/pic.png` }, { name: 42 }],
                        queued: [{ text: `also the tests`, attachments: [] }, { attachments: [] }],
                    },
                ],
            }),
        );

        expect(readTabSnapshot(`sb1`)?.tabs[0]).toEqual({
            conversationId: `a`,
            isolated: true,
            draft: `half a sentence`,
            provider: `codex`,
            harness: `claude-code`,
            session: { id: `sess-1`, provider: `codex` },
            title: `Fix the login handler`,
            attachments: [{ name: `pic.png`, path: `.intentic/attachments/u1/pic.png` }],
            queued: [{ text: `also the tests`, attachments: [] }],
        });
    });
});

describe(`writing a tab snapshot`, () => {
    it(`lands in this window's store and in the seed both`, () => {
        writeTabSnapshot(`sb1`, blob(`a`, [tab(`a`)]));

        expect(session.get(KEY)).toBe(local.get(KEY));
        expect(readTabSnapshot(`sb1`)?.active).toBe(`a`);
    });

    it(`keeps each sandbox's strip to itself`, () => {
        writeTabSnapshot(`sb1`, blob(`a`, [tab(`a`)]));
        writeTabSnapshot(`sb2`, blob(`b`, [tab(`b`)]));

        expect(readTabSnapshot(`sb1`)?.tabs.map((entry) => entry.conversationId)).toEqual([`a`]);
        expect(readTabSnapshot(`sb2`)?.tabs.map((entry) => entry.conversationId)).toEqual([`b`]);
    });
});

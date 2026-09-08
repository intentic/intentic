import { STATE_DIR } from "@intentic/constants";
import { beforeEach, describe, expect, it } from "vitest";

// Pins the reader's contract: every tab named once, a focus naming one of them, nothing readable dropped. A
// duplicate conversationId would collide on Vue's v-for key, scrambling names and closes.

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
        // No conversationId names nothing; a missing draft isn't bindable either.
        session.set(KEY, blob(`b`, [{ draft: `` }, tab(`b`), { conversationId: `c` }]));

        expect(readTabSnapshot(`sb1`)?.tabs.map((entry) => entry.conversationId)).toEqual([`b`]);
    });

    it(`points the focus at the first tab when the stored one names nothing`, () => {
        session.set(KEY, blob(`gone`, [tab(`a`), tab(`b`)]));

        expect(readTabSnapshot(`sb1`)?.active).toBe(`a`);
    });

    it(`degrades an unparseable or empty blob to no snapshot: a fresh tab, not a broken strip`, () => {
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
                        draftAt: 1_700,
                        provider: `codex`,
                        harness: `claude-code`,
                        session: { id: `sess-1`, provider: `codex`, harness: `claude-code` },
                        title: `Fix the login handler`,
                        attachments: [{ name: `pic.png`, path: `${STATE_DIR}/records/artifacts/attachments/u1/pic.png` }, { name: 42 }],
                        queued: [{ text: `also the tests`, attachments: [] }, { attachments: [] }],
                    },
                ],
            }),
        );

        expect(readTabSnapshot(`sb1`)?.tabs[0]).toEqual({
            conversationId: `a`,
            isolated: true,
            registered: false,
            draft: `half a sentence`,
            draftAt: 1_700,
            provider: `codex`,
            harness: `claude-code`,
            session: { id: `sess-1`, provider: `codex`, harness: `claude-code` },
            title: `Fix the login handler`,
            attachments: [{ name: `pic.png`, path: `.intentic/records/artifacts/attachments/u1/pic.png` }],
            queued: [{ text: `also the tests`, attachments: [] }],
        });
    });

    it(`restores a fork's linkage whole, and drops one that reads back partial`, () => {
        session.set(
            KEY,
            blob(`fork`, [
                { ...tab(`fork`), forkOf: { conversationId: `source`, keep: 2, files: `now` } },
                { ...tab(`negative`), forkOf: { conversationId: `source`, keep: -1, files: `then` } },
                { ...tab(`nameless`), forkOf: { conversationId: ``, keep: 2, files: `now` } },
            ]),
        );

        const tabs = readTabSnapshot(`sb1`)?.tabs;
        expect(tabs?.[0]?.forkOf).toEqual({ conversationId: `source`, keep: 2, files: `now` });
        expect(tabs?.[1]?.forkOf).toBeUndefined();
        expect(tabs?.[2]?.forkOf).toBeUndefined();
    });

    // The tab's own pick and the session's can differ mid-switch; both are stored separately.
    it(`restores the tab's account pin and the session's separately`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [
                    {
                        conversationId: `a`,
                        draft: ``,
                        provider: `claude`,
                        account: `acct-work`,
                        session: { id: `sess-1`, provider: `claude`, harness: `native`, account: `acct-personal` },
                        attachments: [],
                        queued: [],
                    },
                ],
            }),
        );

        const restored = readTabSnapshot(`sb1`)?.tabs[0];
        expect(restored?.account).toBe(`acct-work`);
        expect(restored?.session?.account).toBe(`acct-personal`);
    });

    it(`restores the tab's own model, effort and thinking picks`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [
                    {
                        conversationId: `a`,
                        draft: ``,
                        provider: `claude`,
                        model: `claude-sonnet-4-5-20250929`,
                        effort: `medium`,
                        thinking: false,
                        fast: false,
                        attachments: [],
                        queued: [],
                    },
                ],
            }),
        );

        expect(readTabSnapshot(`sb1`)?.tabs[0]).toMatchObject({ model: `claude-sonnet-4-5-20250929`, effort: `medium`, thinking: false });
    });

    it(`restores the persona the tab acts as, and drops one that names nothing`, () => {
        const stored = (actsAs: unknown): unknown =>
            JSON.stringify({ active: `a`, tabs: [{ conversationId: `a`, draft: ``, actsAs, attachments: [], queued: [] }] });

        session.set(KEY, stored(`work`) as string);
        expect(readTabSnapshot(`sb1`)?.tabs[0]).toMatchObject({ actsAs: `work` });

        session.set(KEY, stored(``) as string);
        expect(readTabSnapshot(`sb1`)?.tabs[0]).not.toHaveProperty(`actsAs`);
    });

    it(`drops turn settings that aren't usable values, leaving the restore to fall back`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [{ conversationId: `a`, draft: ``, model: ``, effort: 3, thinking: `yes`, attachments: [], queued: [] }],
            }),
        );

        const restored = readTabSnapshot(`sb1`)?.tabs[0];
        expect(restored).not.toHaveProperty(`model`);
        expect(restored).not.toHaveProperty(`effort`);
        expect(restored).not.toHaveProperty(`thinking`);
    });

    it(`drops a draft stamp that isn't a finite instant`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [{ conversationId: `a`, draft: `half a sentence`, draftAt: `this morning`, attachments: [], queued: [] }],
            }),
        );

        expect(readTabSnapshot(`sb1`)?.tabs[0]).not.toHaveProperty(`draftAt`);
    });

    it(`drops an account that isn't a usable id, leaving the restore to fall back`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [
                    {
                        conversationId: `a`,
                        draft: ``,
                        provider: `claude`,
                        account: ``,
                        session: { id: `sess-1`, provider: `claude`, harness: `native`, account: 42 },
                        attachments: [],
                        queued: [],
                    },
                ],
            }),
        );

        const restored = readTabSnapshot(`sb1`)?.tabs[0];
        expect(restored).not.toHaveProperty(`account`);
        expect(restored?.session).toEqual({ id: `sess-1`, provider: `claude`, harness: `native` });
    });

    it(`drops a session that reads back without what minted it, rather than completing it from the tab`, () => {
        session.set(
            KEY,
            JSON.stringify({
                active: `a`,
                tabs: [
                    {
                        conversationId: `a`,
                        draft: ``,
                        provider: `claude`,
                        harness: `native`,
                        account: `acct-work`,
                        session: { id: `sess-1`, provider: `claude` },
                        attachments: [],
                        queued: [],
                    },
                ],
            }),
        );

        expect(readTabSnapshot(`sb1`)?.tabs[0]?.session).toBeUndefined();
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

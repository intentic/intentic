import type { BrowsingEntry, BrowsingForgetInput, BrowsingHistory } from "@intentic/sandbox-contract/schemas/browsing";
import { unstubbed } from "@intentic/testing";
import { nextTick, ref } from "vue";
import { inSetup, provided } from "../../../testing/inSetup";
import { BROWSING_SOURCE, type BrowsingSource } from "./browsingSource";
import { type HeldHistory, mergeHistory, useBrowsingHistory } from "./useBrowsingHistory";
import { useSearchSuggestions } from "./useSearchSuggestions";

const NOW = 1_790_000_000_000;

const page = (url: string, frecency: number): BrowsingEntry => ({ url, visits: 1, typed: 0, last: NOW, frecency });

const answer = (over: Partial<BrowsingHistory>): BrowsingHistory => ({
    profile: `_own`,
    cursor: `g.1`,
    full: true,
    entries: [],
    removed: [],
    terms: [],
    profiles: [`_own`],
    ...over,
});

const EMPTY: HeldHistory = { entries: [], prepared: [], terms: [], profiles: [], cursor: undefined, loaded: false };

describe("mergeHistory", () => {
    test("a full answer replaces what was held; a delta merges in, best first, forgotten pages gone", () => {
        const full = mergeHistory(EMPTY, answer({ entries: [page(`https://a.example/`, 50), page(`https://b.example/`, 10)] }));
        const delta = mergeHistory(
            full,
            answer({
                full: false,
                cursor: `g.2`,
                entries: [page(`https://b.example/`, 90), page(`https://c.example/`, 5)],
                removed: [`https://a.example/`],
                terms: [{ term: `vue`, count: 1, last: NOW }],
            }),
        );
        expect(delta.entries.map((entry) => entry.url)).toEqual([`https://b.example/`, `https://c.example/`]);
        expect(delta.prepared.map((prepared) => prepared.bare)).toEqual([`b.example/`, `c.example/`]);
        expect(delta.terms).toEqual([{ term: `vue`, count: 1, last: NOW }]);
        expect(delta.cursor).toBe(`g.2`);
        expect(delta.loaded).toBe(true);
    });

    test("an empty delta keeps the prepared pages it had, rather than preparing them again", () => {
        const full = mergeHistory(EMPTY, answer({ entries: [page(`https://a.example/`, 50)] }));
        expect(mergeHistory(full, answer({ full: false, cursor: `g.9` })).prepared).toBe(full.prepared);
    });
});

describe("useBrowsingHistory", () => {
    test("asks for everything first, then only what changed since the cursor it was given; forgets through the sandbox", async () => {
        const asked: (string | undefined)[] = [];
        const forgotten: BrowsingForgetInput[] = [];
        const answers = [
            answer({ entries: [page(`https://a.example/`, 50), page(`https://b.example/`, 10)], cursor: `g.1` }),
            answer({ full: false, cursor: `g.2`, entries: [page(`https://c.example/`, 70)] }),
            answer({ full: false, cursor: `g.3`, removed: [`https://a.example/`] }),
        ];
        const source = unstubbed<BrowsingSource>(`source`, {
            history: async (_profile, since) => {
                asked.push(since);
                return answers.shift() ?? answer({ full: false });
            },
            forget: async (input) => {
                forgotten.push(input);
                return 1;
            },
        });
        const profile = ref(`_test-${Math.random()}`);
        const { result, stop } = inSetup(() => useBrowsingHistory(profile), { provides: [provided(BROWSING_SOURCE, source)] });
        expect(result.history.value.loaded).toBe(false);
        await result.refresh();
        await result.refresh();
        expect(result.history.value.entries.map((entry) => entry.url)).toEqual([`https://c.example/`, `https://a.example/`, `https://b.example/`]);

        const forgetting = result.forget({ kind: `urls`, urls: [`https://a.example/`] });
        // Gone from the held copy at once, before the sandbox has answered.
        expect(result.history.value.entries.map((entry) => entry.url)).toEqual([`https://c.example/`, `https://b.example/`]);
        await forgetting;
        expect(forgotten).toEqual([{ profile: profile.value, forget: { kind: `urls`, urls: [`https://a.example/`] } }]);
        expect(asked).toEqual([undefined, `g.1`, `g.2`]);
        stop();
    });
});

describe("useSearchSuggestions", () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    test("asks the engine once typing pauses, and only for text that is not an address or a keyword search", async () => {
        const asked: string[] = [];
        const source = unstubbed<BrowsingSource>(`source`, {
            suggest: async (q, engine) => {
                asked.push(`${engine}:${q}`);
                return { q, suggestions: [`${q} login`] };
            },
        });
        const text = ref(``);
        const engine = ref<`brave` | `google`>(`brave`);
        const open = ref(true);
        const { result, stop } = inSetup(() => useSearchSuggestions(text, engine, open, 0), { provides: [provided(BROWSING_SOURCE, source)] });
        text.value = `rou`;
        await nextTick();
        text.value = `router`;
        await nextTick();
        await settle();
        expect(result.value).toEqual([`router login`]);
        expect(asked).toEqual([`brave:router`]);

        for (const typed of [`192.168.0.168`, `yt lofi`, `https://x.test`]) {
            text.value = typed;
            await nextTick();
            await settle();
            expect(result.value).toEqual([]);
        }
        // Closed, it asks nothing.
        open.value = false;
        text.value = `weather`;
        await nextTick();
        await settle();
        expect(asked).toEqual([`brave:router`]);
        stop();
    });

    test("a late answer for text no longer there is dropped", async () => {
        let release: (() => void) | undefined;
        const source = unstubbed<BrowsingSource>(`source`, {
            suggest: (q) =>
                new Promise((resolve) => {
                    release = () => resolve({ q, suggestions: [`${q} stale`] });
                }),
        });
        const text = ref(`old`);
        const { result, stop } = inSetup(() => useSearchSuggestions(text, ref(`brave` as const), ref(true), 0), {
            provides: [provided(BROWSING_SOURCE, source)],
        });
        await settle();
        text.value = `new text`;
        release?.();
        await settle();
        expect(result.value).toEqual([]);
        stop();
    });
});

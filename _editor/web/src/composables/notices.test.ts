import { type NoticeModel, rankNotices } from "@intentic/ui/notice";
import { describe, expect, it } from "vitest";
import { noticeFrom, noticeOf } from "./useAsyncAction";

/* The two halves of "one voice per problem": what a caught thing turns into, and which of several the user
 * reads first. Both live in leaves — @intentic/ui ships no test runner (same reason as dagLayout.test.ts), and
 * useAsyncAction's helpers are pure functions over a caught value. */

const notice = (tone: NoticeModel[`tone`], title: string, key?: string): NoticeModel => ({ tone, title, key });

describe(`noticeFrom`, () => {
    it(`leads with the app's sentence and keeps the caught message as evidence`, () => {
        // path-literals: content — the OS's own error text, quoted as the kernel emits it, not a path this test builds.
        const built = noticeFrom(new Error(`EACCES: permission denied, open '/work/.env'`), `Couldn't save your changes.`);
        expect(built.title).toBe(`Couldn't save your changes.`);
        expect(built.detail).toBe(`EACCES: permission denied, open '/work/.env'`);
        expect(built.tone).toBe(`danger`);
    });

    it(`drops a detail that only repeats the title`, () => {
        expect(noticeFrom(new Error(`Couldn't save your changes.`), `Couldn't save your changes.`).detail).toBeUndefined();
    });

    // A throw with nothing to say is the common case for a network drop, and an empty grey line under the
    // sentence reads as a missing message rather than as an absent one.
    it(`drops a detail there is none of`, () => {
        expect(noticeFrom(new Error(``), `Couldn't reach your sandbox.`).detail).toBeUndefined();
        expect(noticeFrom(undefined, `Couldn't reach your sandbox.`).detail).toBeUndefined();
        expect(noticeFrom({ nothing: true }, `Couldn't reach your sandbox.`).detail).toBeUndefined();
    });

    it(`carries the way out when the caller offers one`, () => {
        const run = (): void => {};
        expect(noticeFrom(new Error(`409`), `That file changed on disk.`, { action: { label: `Reload`, run } }).action?.label).toBe(`Reload`);
        // And says nothing when there isn't one: a button the app cannot honour is worse than no button.
        expect(noticeOf(`Reconnecting…`, { tone: `info` }).action).toBeUndefined();
    });
});

describe(`rankNotices`, () => {
    it(`puts the worst first, whatever order the view raised them in`, () => {
        const ranked = rankNotices([notice(`info`, `Reconnecting…`), notice(`danger`, `Couldn't save.`), notice(`warning`, `Read-only.`)]);
        expect(ranked.map((entry) => entry.title)).toEqual([`Couldn't save.`, `Read-only.`, `Reconnecting…`]);
    });

    it(`keeps equally-bad failures in the order the view knows about`, () => {
        const ranked = rankNotices([notice(`danger`, `First.`), notice(`danger`, `Second.`), notice(`danger`, `Third.`)]);
        expect(ranked.map((entry) => entry.title)).toEqual([`First.`, `Second.`, `Third.`]);
    });

    // One failure reaching a view through three queries is one problem. Saying it three times reads as three.
    it(`says one problem once`, () => {
        const ranked = rankNotices([notice(`danger`, `Lost contact.`), notice(`danger`, `Lost contact.`), notice(`warning`, `Lost contact.`)]);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]?.tone).toBe(`danger`);
    });

    it(`keeps the richer copy when a barer one follows it`, () => {
        const rich: NoticeModel = { tone: `danger`, title: `Couldn't push.`, detail: `non-fast-forward`, key: `push` };
        const bare: NoticeModel = { tone: `danger`, title: `Couldn't push.`, key: `push` };
        expect(rankNotices([rich, bare])[0]?.detail).toBe(`non-fast-forward`);
    });

    it(`tells apart failures a shared key says are different problems`, () => {
        const ranked = rankNotices([notice(`danger`, `Couldn't reach it.`, `agents`), notice(`danger`, `Couldn't reach it.`, `changes`)]);
        expect(ranked).toHaveLength(2);
    });
});

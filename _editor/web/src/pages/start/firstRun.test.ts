// @vitest-environment jsdom
import type { PublicFile } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { BUILD_IDEAS, blockedPage, buildPrompt, builtPage, firstRunDone, markFirstRunDone } from "./firstRun";

const file = (path: string, blocked?: string): PublicFile => ({
    path,
    size: 1,
    modifiedAt: 0,
    ...(blocked === undefined ? { url: `https://public.test/${path}` } : { blocked }),
});

describe(`the first-run flag`, () => {
    beforeEach(() => localStorage.clear());

    it(`is unset until the screen has been answered`, () => {
        expect(firstRunDone()).toBe(false);
        markFirstRunDone();
        expect(firstRunDone()).toBe(true);
    });
});

describe(`the task the screen sends`, () => {
    /* The four constraints that keep a first run fast and unable to fail in a way that reads as the product
     * being broken. Each is pinned by name rather than by matching the whole prompt: the prose around them is
     * meant to be edited, and a snapshot would make every wording change look like a behaviour change. */
    it(`asks for one self-contained file in the outbox, and nothing else`, () => {
        const prompt = buildPrompt(`a page for my bakery`);

        expect(prompt).toContain(`a page for my bakery`);
        expect(prompt).toContain(`public/index.html`);
        expect(prompt).toContain(`No build step`);
        expect(prompt).toContain(`don't ask me anything first`);
        // The workspace belongs to whoever came here with real work; the demo may not plant a repo in it.
        expect(prompt).toContain(`Don't create a repository`);
    });

    it(`tells the agent the outbox is public, in the same words the screen tells the user`, () => {
        expect(buildPrompt(`anything`)).toContain(`served on the open internet`);
    });

    it(`trims the idea, so a pasted sentence doesn't arrive with its whitespace`, () => {
        expect(buildPrompt(`  a tea shop  `)).toContain(`Build me a small website: a tea shop\n`);
    });

    // Three ideas from three different worlds — the row's job is to read as "anything", not as three landing
    // pages. A duplicate label would also make the chips ambiguous to click.
    it(`offers distinct examples`, () => {
        expect(new Set(BUILD_IDEAS.map((entry) => entry.label)).size).toBe(BUILD_IDEAS.length);
        expect(BUILD_IDEAS.length).toBeGreaterThanOrEqual(3);
    });
});

describe(`reading the outbox for the built page`, () => {
    it(`finds nothing before the agent has written anything`, () => {
        expect(builtPage([])).toBeUndefined();
    });

    it(`prefers the index the task asks for`, () => {
        expect(builtPage([file(`about.html`), file(`index.html`)])?.path).toBe(`index.html`);
    });

    it(`accepts another page when the agent named the file something else`, () => {
        expect(builtPage([file(`game.html`)])?.path).toBe(`game.html`);
    });

    it(`ignores files that are in the outbox but not served`, () => {
        expect(builtPage([file(`index.html`, `blocked-name`)])).toBeUndefined();
    });

    /* The outcome that would otherwise look exactly like nothing having happened: the page is there, a guard
     * refuses it, and only the publisher can be told why. */
    it(`surfaces a refused page so the screen can say why`, () => {
        expect(blockedPage([file(`index.html`, `blocked-name`)])?.blocked).toBe(`blocked-name`);
        expect(blockedPage([file(`index.html`)])).toBeUndefined();
    });

    // A non-page in the outbox is not the thing this screen is waiting for.
    it(`does not mistake a stray asset for the built page`, () => {
        expect(builtPage([file(`notes.txt`)])).toBeUndefined();
    });
});

// @vitest-environment jsdom
//
// jsdom because the whole subject is what survives a reload, and that is localStorage: under `node` the
// storage boundary degrades to in-memory (browserStorage.ts) and every persistence assertion here would pass
// for the wrong reason.
import { beforeEach, expect, it, vi } from "vitest";

/* THE TWO SCOPES, which are the only thing worth pinning here: a yes belongs to the browser and a no belongs to
 * the sandbox. Get them the wrong way round and the product misbehaves in ways nobody would file a bug for:
 * a browser-wide no silently costs every future sandbox the shortcut with no way back, and a sandbox-scoped
 * yes re-raises a permission the browser already granted, every time the user adds a sandbox. */

const LAPTOP = `1111aaaa`;
const DESKTOP = `2222bbbb`;

// A fresh module registry over the SAME localStorage is exactly what a reload is.
const load = async () => {
    vi.resetModules();
    const [shortcut, active] = await Promise.all([import(`./localShortcut`), import(`./activeSandbox`)]);
    return { ...shortcut.useLocalShortcut(), answerFor: shortcut.shortcutAnswer, activeSandboxId: active.activeSandboxId };
};

beforeEach(() => {
    localStorage.clear();
});

it(`asks about a sandbox once, and only while the user is looking at it`, async () => {
    const { question, ask, answerFor, activeSandboxId } = await load();
    activeSandboxId.value = LAPTOP;

    expect(answerFor(LAPTOP)).toBe(`unasked`);
    expect(question.value).toBeUndefined();

    ask(LAPTOP);
    expect(question.value).toBe(LAPTOP);

    // Switched away mid-question: the card would now be offering to speed up something the user has navigated
    // off. It is dropped rather than re-pointed, whether the new sandbox is worth asking about is the probe's
    // call, and it makes it on arrival.
    activeSandboxId.value = DESKTOP;
    expect(question.value).toBeUndefined();
});

it(`keeps a yes for the whole browser, because that is the scope of the permission it stands for`, async () => {
    const first = await load();
    first.activeSandboxId.value = LAPTOP;
    first.ask(LAPTOP);
    first.allow();

    expect(first.question.value).toBeUndefined();
    expect(first.answerFor(LAPTOP)).toBe(`allowed`);
    // A sandbox this browser has never seen inherits it: Chrome's own grant is per origin, so asking again
    // would be asking for something we already have.
    expect(first.answerFor(DESKTOP)).toBe(`allowed`);

    const reloaded = await load();
    expect(reloaded.answerFor(LAPTOP)).toBe(`allowed`);
    expect(reloaded.answerFor(DESKTOP)).toBe(`allowed`);
});

it(`keeps a no for that sandbox alone, so the answer can change when the user's machines do`, async () => {
    const first = await load();
    first.activeSandboxId.value = DESKTOP;
    first.ask(DESKTOP);
    first.decline(DESKTOP);

    expect(first.question.value).toBeUndefined();
    expect(first.answerFor(DESKTOP)).toBe(`declined`);
    // The sandbox they set up on the laptop in front of them tomorrow is a different question, and it still
    // gets asked: this is what stands in for a settings page nobody would find.
    expect(first.answerFor(LAPTOP)).toBe(`unasked`);

    const reloaded = await load();
    expect(reloaded.answerFor(DESKTOP)).toBe(`declined`);
    expect(reloaded.answerFor(LAPTOP)).toBe(`unasked`);
});

it(`lets a later yes cover a sandbox already refused, without a way to un-grant the browser`, async () => {
    // Declining one sandbox and allowing on another is the ordinary path for someone who works across two
    // machines. The browser-wide yes wins, because it describes a permission that genuinely has been given.
    const { answerFor, decline, allow } = await load();
    decline(DESKTOP);
    expect(answerFor(DESKTOP)).toBe(`declined`);
    allow();
    expect(answerFor(DESKTOP)).toBe(`allowed`);
});

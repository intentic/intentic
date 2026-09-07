// @vitest-environment jsdom
//
// jsdom because the whole subject is what survives a reload, and that is localStorage: under `node` the
// storage boundary degrades to in-memory (browserStorage.ts) and every persistence assertion here would pass
// for the wrong reason.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/* THE TWO SCOPES, which are the only thing worth pinning here: a yes belongs to the browser and a no belongs to
 * the sandbox. Get them the wrong way round and the product misbehaves in ways nobody would file a bug for:
 * a browser-wide no silently costs every future sandbox the shortcut with no way back, and a sandbox-scoped
 * yes re-raises a permission the browser already granted, every time the user adds a sandbox.
 *
 * …and the authority above both of them, which is Chrome. What this module keeps is a record of a conversation
 * about a permission it does not own, so every case below stands a browser up first: the stored answers only
 * decide anything while the browser is still at `prompt`. */

const LAPTOP = `1111aaaa`;
const DESKTOP = `2222bbbb`;

/* The browser this test is pretending to be. `undefined` is a browser with no Local Network Access permission
 * at all — WebKit and Firefox, and every Chrome before 142 — which is jsdom's own state and the one the app
 * has to read as "nothing is in the way" rather than as "ask". Only `loopback-network` is answered, because
 * that is the name the app asks under first (loopbackPermission.ts). */
const browserSays = (state: PermissionState | undefined): void => {
    if (state === undefined) {
        Reflect.deleteProperty(globalThis.navigator, `permissions`);
        return;
    }
    Object.defineProperty(globalThis.navigator, `permissions`, {
        configurable: true,
        value: {
            query: ({ name }: PermissionDescriptor): Promise<PermissionStatus> =>
                String(name) === `loopback-network`
                    ? Promise.resolve({ state } as PermissionStatus)
                    : Promise.reject(new TypeError(`unknown permission ${String(name)}`)),
        },
    });
};

// A fresh module registry over the SAME localStorage is exactly what a reload is. Loaded AFTER `browserSays`,
// because the permission is asked once per document and remembered.
const load = async () => {
    vi.resetModules();
    const [shortcut, active] = await Promise.all([import(`./localShortcut`), import(`../overview/activeSandbox`)]);
    return { ...shortcut.useLocalShortcut(), answerFor: shortcut.shortcutAnswer, activeSandboxId: active.activeSandboxId };
};

beforeEach(() => {
    localStorage.clear();
    // The browser the card exists for: one that gates the reach and has not been answered yet.
    browserSays(`prompt`);
});

afterEach(() => {
    browserSays(undefined);
    Reflect.deleteProperty(globalThis.window, `__INTENTIC_DESKTOP__`);
});

it(`asks about a sandbox once, and only while the user is looking at it`, async () => {
    const { question, ask, answerFor, activeSandboxId } = await load();
    activeSandboxId.value = LAPTOP;

    expect(await answerFor(LAPTOP)).toBe(`unasked`);
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
    expect(await first.answerFor(LAPTOP)).toBe(`allowed`);
    // A sandbox this browser has never seen inherits it: Chrome's own grant is per origin, so asking again
    // would be asking for something we already have.
    expect(await first.answerFor(DESKTOP)).toBe(`allowed`);

    const reloaded = await load();
    expect(await reloaded.answerFor(LAPTOP)).toBe(`allowed`);
    expect(await reloaded.answerFor(DESKTOP)).toBe(`allowed`);
});

it(`keeps a no for that sandbox alone, so the answer can change when the user's machines do`, async () => {
    const first = await load();
    first.activeSandboxId.value = DESKTOP;
    first.ask(DESKTOP);
    first.decline(DESKTOP);

    expect(first.question.value).toBeUndefined();
    expect(await first.answerFor(DESKTOP)).toBe(`declined`);
    // The sandbox they set up on the laptop in front of them tomorrow is a different question, and it still
    // gets asked: this is what stands in for a settings page nobody would find.
    expect(await first.answerFor(LAPTOP)).toBe(`unasked`);

    const reloaded = await load();
    expect(await reloaded.answerFor(DESKTOP)).toBe(`declined`);
    expect(await reloaded.answerFor(LAPTOP)).toBe(`unasked`);
});

it(`lets a later yes cover a sandbox already refused, without a way to un-grant the browser`, async () => {
    // Declining one sandbox and allowing on another is the ordinary path for someone who works across two
    // machines. The browser-wide yes wins, because it describes a permission that genuinely has been given.
    const { answerFor, decline, allow } = await load();
    decline(DESKTOP);
    expect(await answerFor(DESKTOP)).toBe(`declined`);
    allow();
    expect(await answerFor(DESKTOP)).toBe(`allowed`);
});

/* WHAT THE CARD IS FOR IS THE DIALOG, so a browser that will not raise one is never asked. This is the case the
 * app got wrong for every WebKit and Firefox user: a question about a permission that does not exist there, to
 * buy a reach they already had, promising an interruption that was never coming. */
it(`asks nobody in a browser with no such permission`, async () => {
    browserSays(undefined);
    const { answerFor, question } = await load();

    expect(await answerFor(LAPTOP)).toBe(`allowed`);
    expect(question.value).toBeUndefined();
});

/* The second sandbox, the second window, and the managed profile an administrator pre-granted with
 * `LocalNetworkAccessAllowedForUrls`: all the same state, and all of them a grant the app already has. */
it(`asks nobody once Chrome already holds the grant`, async () => {
    browserSays(`granted`);
    const { answerFor, decline } = await load();

    expect(await answerFor(LAPTOP)).toBe(`allowed`);
    // Even for one the user turned down while it was still a question about which machine the sandbox is on:
    // a permission that has genuinely been given outranks a note about a sandbox.
    decline(DESKTOP);
    expect(await answerFor(DESKTOP)).toBe(`allowed`);
});

/* A REVOKE IN CHROME'S SITE SETTINGS IS FINAL, and it is the case the stored yes could not see. The app used to
 * go on probing an address the browser now refuses, then read the refusal as a sandbox that had moved and spend
 * the demotion backoff on it — every reconnect, for the rest of the session. */
it(`stops reaching when Chrome says no, whatever this app was told earlier`, async () => {
    const granted = await load();
    granted.allow();
    expect(await granted.answerFor(LAPTOP)).toBe(`allowed`);

    browserSays(`denied`);
    const revoked = await load();
    expect(await revoked.answerFor(LAPTOP)).toBe(`declined`);
    expect(revoked.question.value).toBeUndefined();
});

/* The desktop app settled this at install time: its workspace webview loads one origin and does not gate the
 * reach at all (desktop-app windows.rs), so there is no dialog to explain and no card to explain it with. */
it(`asks nobody inside a desktop webview that does not gate the reach`, async () => {
    globalThis.window.__INTENTIC_DESKTOP__ = { version: `1.2.3`, installId: `i`, update: null, loopbackUngated: true };
    const { answerFor } = await load();

    expect(await answerFor(LAPTOP)).toBe(`allowed`);
});

/* …but an OLDER app is a webview that still enforces it, and it says nothing. The two ship separately — this
 * SPA continuously, the app as a binary somebody installed once — so this is an ordinary state, and reading it
 * as "ungated" would hand that user Chrome's dialog with nothing on screen to place it. */
it(`still asks inside a desktop webview that has not said it is ungated`, async () => {
    globalThis.window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `i`, update: null };
    const { answerFor } = await load();

    expect(await answerFor(LAPTOP)).toBe(`unasked`);
});

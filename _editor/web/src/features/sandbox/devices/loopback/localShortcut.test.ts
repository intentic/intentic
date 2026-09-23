// jsdom because the subject is what survives a reload: under `node` the storage boundary degrades to
// in-memory and every persistence assertion would pass for the wrong reason.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import type { LoopbackPermission } from "./loopbackPermission";
import { activeSandboxId } from "../../overview/activeSandbox";

// A yes belongs to the browser, a no belongs to the sandbox; swapped, either costs every future sandbox the
// shortcut or re-prompts an already-granted permission. Stored answers matter only while Chrome is at `prompt`.

const LAPTOP = `1111aaaa`;
const DESKTOP = `2222bbbb`;

// The browser's verdict, given rather than read: loopbackPermission holds its query for the life of the
// document (its own suite covers what it reads off the Permissions API), so nothing under this module could
// change it between cases.
const browser = { verdict: `prompt` as LoopbackPermission };
const browserSays = (verdict: LoopbackPermission): void => {
    browser.verdict = verdict;
};
jest.mock("./loopbackPermission", () => ({ loopbackPermission: async () => browser.verdict }));

// A fresh module over the same localStorage is what a reload is.
const load = async () => {
    const shortcut = await freshImport<typeof import("./localShortcut")>("./localShortcut", import.meta.url);
    return { ...shortcut.useLocalShortcut(), answerFor: shortcut.shortcutAnswer };
};

beforeEach(() => {
    localStorage.clear();
    // The browser the card exists for: gates the reach, unanswered yet.
    browserSays(`prompt`);
});

it(`asks about a sandbox once, and only while the user is looking at it`, async () => {
    const { question, ask, answerFor } = await load();
    activeSandboxId.value = LAPTOP;

    expect(await answerFor(LAPTOP)).toBe(`unasked`);
    expect(question.value).toBeUndefined();

    ask(LAPTOP);
    expect(question.value).toBe(LAPTOP);

    // Switching away strands the question rather than re-pointing it; whether the new sandbox is worth asking is
    // the probe's call on arrival.
    activeSandboxId.value = DESKTOP;
    expect(question.value).toBeUndefined();
});

it(`keeps a yes for the whole browser, because that is the scope of the permission it stands for`, async () => {
    const first = await load();
    activeSandboxId.value = LAPTOP;
    first.ask(LAPTOP);
    first.allow();

    expect(first.question.value).toBeUndefined();
    expect(await first.answerFor(LAPTOP)).toBe(`allowed`);
    // A sandbox never seen before inherits the yes: Chrome's grant is per origin, not per sandbox.
    expect(await first.answerFor(DESKTOP)).toBe(`allowed`);

    const reloaded = await load();
    expect(await reloaded.answerFor(LAPTOP)).toBe(`allowed`);
    expect(await reloaded.answerFor(DESKTOP)).toBe(`allowed`);
});

it(`keeps a no for that sandbox alone, so the answer can change when the user's machines do`, async () => {
    const first = await load();
    activeSandboxId.value = DESKTOP;
    first.ask(DESKTOP);
    first.decline(DESKTOP);

    expect(first.question.value).toBeUndefined();
    expect(await first.answerFor(DESKTOP)).toBe(`declined`);
    // A sandbox set up tomorrow is a different question and still gets asked; this stands in for a settings page.
    expect(await first.answerFor(LAPTOP)).toBe(`unasked`);

    const reloaded = await load();
    expect(await reloaded.answerFor(DESKTOP)).toBe(`declined`);
    expect(await reloaded.answerFor(LAPTOP)).toBe(`unasked`);
});

it(`lets a later yes cover a sandbox already refused, without a way to un-grant the browser`, async () => {
    // The ordinary path for someone working across two machines; the browser-wide yes wins since it's a permission
    // genuinely given.
    const { answerFor, decline, allow } = await load();
    decline(DESKTOP);
    expect(await answerFor(DESKTOP)).toBe(`declined`);
    allow();
    expect(await answerFor(DESKTOP)).toBe(`allowed`);
});

// The dialog is the point, so a browser that never raises one is never asked — the case WebKit/Firefox got
// wrong: a question about a permission that doesn't exist, buying a reach already held.
it(`asks nobody in a browser with no such permission`, async () => {
    browserSays(`ungated`);
    const { answerFor, question } = await load();

    expect(await answerFor(LAPTOP)).toBe(`allowed`);
    expect(question.value).toBeUndefined();
});

// Same state for a second sandbox, a second window, or an administrator-pregranted profile: all already a
// grant the app has.
it(`asks nobody once Chrome already holds the grant`, async () => {
    browserSays(`granted`);
    const { answerFor, decline } = await load();

    expect(await answerFor(LAPTOP)).toBe(`allowed`);
    // A genuine grant outranks a stored no, even one made about which machine a sandbox was on.
    decline(DESKTOP);
    expect(await answerFor(DESKTOP)).toBe(`allowed`);
});

// A revoke in Chrome's site settings is final and invisible to a stored yes; unread, the app would keep probing
// a refused address and spend the demotion backoff on it.
it(`stops reaching when Chrome says no, whatever this app was told earlier`, async () => {
    const granted = await load();
    granted.allow();
    expect(await granted.answerFor(LAPTOP)).toBe(`allowed`);

    browserSays(`denied`);
    const revoked = await load();
    expect(await revoked.answerFor(LAPTOP)).toBe(`declined`);
    expect(revoked.question.value).toBeUndefined();
});

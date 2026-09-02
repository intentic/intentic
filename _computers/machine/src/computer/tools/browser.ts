import { sleep } from "@intentic/base/async";
import { type Browser, BrowserError, renderPage } from "@intentic/browser";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* The browser, driven by what is ON the page rather than where it is on screen.
 *
 * `computer` can already click a browser, badly. Coordinates move when the window moves, a scroll invalidates
 * every one of them, and "the Submit button" is a guess about which grey rectangle is which. A browser will
 * simply say what it is showing, so these tools ask it: snapshot the page, act on an element by reference. The
 * same instruction then works at any window size, on any machine, after any re-render.
 *
 * SCOPES, following the rule the rest of the tools use, what the action DOES, not what implements it:
 *   snapshot / read   → `screen`, because they are ways of seeing what is on the machine.
 *   click / fill / key → `control`, because they change what the machine is doing.
 *   open               → `shell`, because it may start a browser process.
 *
 * THE BROWSER IT DRIVES IS NOT THE USER'S OWN. A browser only speaks this protocol if it was started with a
 * debugging port, and nobody's everyday browser was; restarting theirs would close every tab they had open. So a
 * separate instance runs against its own profile, which the user signs into once. Their session is never
 * automated and never at risk from a misfired click, and the sign-in is a thing they do deliberately, in a
 * window they can watch, rather than a credential handed to an agent. */

export const openPage = async (web: Browser, url: string, scopes: HostScopes): Promise<string> => {
    // Opening may start a browser process, which is what the shell switch governs.
    assertScope(scopes, "shell");
    if (url === "") {
        throw new BrowserError(`"url" is required: the page to open.`);
    }
    // A bare host is what people type; a browser needs the scheme, and refusing over a missing "https://" would
    // be pedantry rather than safety.
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    return renderPage(await web.open(target));
};

export const snapshotPage = async (web: Browser, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    return renderPage(await web.snapshot());
};

export const readPage = async (web: Browser, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const text = await web.text();
    return text.trim() === "" ? "That page has no readable text, it may still be loading, or it may be a canvas or a PDF." : text;
};

/* Every action answers with a FRESH SNAPSHOT, for the same reason `computer` answers with a screenshot: the page
 * after a click is a different page, and an agent that has to ask what happened will either forget to or will
 * spend a round trip finding out. This is the difference between one call per step and three. */
export const clickElement = async (web: Browser, ref: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (ref === "") {
        throw new BrowserError(`"ref" is required: take a snapshot and use one of the [e…] references from it.`);
    }
    await web.click(ref);
    await settle();
    return `Clicked ${ref}.\n\n${renderPage(await web.snapshot())}`;
};

export const fillElement = async (web: Browser, ref: string, text: string, submit: boolean, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (ref === "") {
        throw new BrowserError(`"ref" is required: take a snapshot and use one of the [e…] references from it.`);
    }
    await web.fill(ref, text, submit);
    await settle();
    // Counted, never echoed: a filled field is as likely to hold a password as anything typed on the keyboard.
    return `Typed ${text.length} characters into ${ref}${submit ? " and submitted" : ""}.\n\n${renderPage(await web.snapshot())}`;
};

export const pressKey = async (web: Browser, combo: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    await web.press(combo === "" ? "Return" : combo);
    await settle();
    return `Pressed ${combo === "" ? "Return" : combo}.\n\n${renderPage(await web.snapshot())}`;
};

export const listTabs = async (web: Browser, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const tabs = await web.tabs();
    if (tabs.length === 0) {
        return "The browser has no open tabs.";
    }
    return [
        `${tabs.length} tab${tabs.length === 1 ? "" : "s"} (* = the one these tools are acting on). Pass an id to switch.`,
        ...tabs.map((tab) => `${tab.active ? "* " : "  "}[${tab.id}] ${tab.title}, ${tab.url}`),
    ].join("\n");
};

export const selectTab = async (web: Browser, id: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (id === "") {
        throw new BrowserError(`"id" is required: list the tabs and pass one of the ids in brackets.`);
    }
    return renderPage(await web.selectTab(id));
};

// A page needs a beat after an action before its next state is worth reading: a click that triggers a fetch, a
// framework that re-renders on the next tick. Without it the snapshot describes the page BEFORE the action.
const settle = (): Promise<void> => sleep(500);

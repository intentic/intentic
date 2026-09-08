import { sleep } from "@intentic/base/async";
import { type Browser, BrowserError, renderPage } from "@intentic/browser";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

// The browser, driven by what is on the page rather than where it is on screen: snapshot it, act on an element
// by reference, so the same instruction works at any window size or re-render. Scopes follow the apps.ts rule
// (look -> `screen`, change -> `control`, open -> `shell`). The browser is a separate instance with its own
// profile, never the user's own, so a misfired click never touches their session.

export const openPage = async (web: Browser, url: string, scopes: HostScopes): Promise<string> => {
    // Opening may start a browser process, which is what the shell switch governs.
    assertScope(scopes, "shell");
    if (url === "") {
        throw new BrowserError(`"url" is required: the page to open.`);
    }
    // A bare host is what people type; a browser needs the scheme, and refusing over a missing "https://" would be
    // pedantry rather than safety.
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

// Every action answers with a fresh snapshot: the page after a click is a different page, and an agent that has
// to ask what happened will forget to, or spend a round trip finding out.
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

// A page needs a beat after an action before its next state is worth reading, a click that triggers a fetch, a
// re-render on the next tick.
const settle = (): Promise<void> => sleep(500);

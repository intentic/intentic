import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { renderPage, toPageState } from "@intentic/browser/page";
import {
    askConfirm,
    clickRef,
    collectPage,
    describeRef,
    fillRef,
    flashBanner,
    pressKeyOnPage,
    readPageText,
    scrollPage,
    selectRef,
    waitForText,
} from "../../page/driver.js";
import { assertRunning, assertScope, needsConfirm, RefusedError } from "../policy.js";
import { store } from "../store.js";
import { targetTab } from "./tab-access.js";

/* THE PAGE TOOLS. Each one is the same three steps: get a permitted tab, run something in it, say what
 * happened in words the model can act on.
 *
 * WHY EVERY ACTION ANSWERS WITH THE PAGE AFTERWARDS. A click is only half an observation — what matters is
 * what the page became. Returning the new snapshot with each action removes an entire class of turn ("click,
 * then snapshot, then reason") and, more importantly, removes the failure where the model acts twice because
 * it could not tell whether the first one landed.
 *
 * WHY THE BANNER IS NOT OPTIONAL. Every action flashes a line in the corner of the tab it happened in. The
 * person is sitting in front of this browser; an agent working invisibly in it would be a different, much worse
 * product. It is fire-and-forget: a banner that failed to render must never fail the action it describes. */

// How long a confirmation panel waits for a human before it counts as "no".
const CONFIRM_TIMEOUT_MS = 120_000;
// The ceiling on wait_for, so a tool call cannot outlive the socket's own patience.
const MAX_WAIT_SECONDS = 60;

// Run one of the injected functions in a tab and hand back what it returned. The `func`/`args` pair is what
// chrome.scripting serializes — see page/driver.ts for the rule every one of those functions is written to.
const inject = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Result, args: Args): Promise<Awaited<Result>> => {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    if (frame?.result === undefined) {
        throw new RefusedError(`That page did not answer. It may have navigated mid-call, or it may be a page no extension can touch.`);
    }
    return frame.result;
};

const announce = (tabId: number, message: string): void => {
    void chrome.scripting.executeScript({ target: { tabId }, func: flashBanner, args: [message] }).catch(() => undefined);
};

// The page, rendered in the shared vocabulary (@intentic/browser/page) so that an agent driving this browser
// and one driving the sandbox's own read the same thing.
const pageText = async (tabId: number): Promise<string> => {
    const snapshot = await inject(tabId, collectPage, []);
    const rendered = renderPage(toPageState(snapshot), snapshot.truncated);
    return snapshot.loading ? `${rendered}\n(the page is still loading: take another snapshot in a moment if what you need is missing)` : rendered;
};

export const snapshot = async (tabId?: number): Promise<string> => {
    const tab = await targetTab("read", tabId);
    return await pageText(tab.id);
};

export const readable = async (tabId?: number): Promise<string> => {
    const tab = await targetTab("read", tabId);
    const page = await inject(tab.id, readPageText, []);
    return [
        `Page: ${page.title === "" ? "(untitled)" : page.title}`,
        page.url,
        ``,
        page.text === "" ? `(this page has no readable text: try a snapshot, it may be an app rather than a document)` : page.text,
        ...(page.truncated ? [`…(truncated)`] : []),
    ].join("\n");
};

/* Point a tab at a URL.
 *
 * NAVIGATING IS NOT READING, and the permission this asks for follows that. It needs the acting switch (it
 * changes what is on somebody's screen) and it does NOT need the destination to be granted — anyone may open a
 * tab. What needs the grant is looking at what lands there, so the answer says plainly when the page is one
 * this browser has not been allowed on.
 *
 * The earlier shape asked for an acting grant on the tab the person happened to be looking at, which refused
 * the most ordinary first move there is: "open github.com" from a blank tab, on a browser whose sites are all
 * granted. The source page is not the subject of this action; the destination is. */
export const openUrl = async (url: string, where: "current" | "new"): Promise<string> => {
    const [scopes, paused] = await Promise.all([store.scopes(), store.paused()]);
    assertRunning(paused);
    assertScope(scopes, "act");
    const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const active = where === "new" ? undefined : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (where === "current" && active?.id === undefined) {
        throw new RefusedError(`This browser has no active tab to point somewhere.`);
    }
    const tab =
        where === "new" || active?.id === undefined
            ? await chrome.tabs.create({ url: target, active: true })
            : await chrome.tabs.update(active.id, { url: target });
    if (tab.id === undefined) {
        return `Opened ${target}.`;
    }
    // Give the navigation a moment to commit: reading the old page back would be worse than a short wait.
    await sleep(600);
    try {
        const permitted = await targetTab("read", tab.id);
        announce(permitted.id, `The agent opened this page`);
        return await pageText(permitted.id);
    } catch (error) {
        return `Opened ${target}. ${errorMessage(error)}`;
    }
};

/* An acting tool's one extra step: ask the person, when the switches say to. The question is rendered IN the
 * page, next to the thing it is about, and a question nobody answers is a no (page/driver.ts). */
const confirmed = async (tabId: number, what: string, sensitive: boolean): Promise<void> => {
    const scopes = await store.scopes();
    if (!needsConfirm(scopes, sensitive)) {
        return;
    }
    const ok = await inject(tabId, askConfirm, [`Your agent wants to ${what}. Allow it?`, CONFIRM_TIMEOUT_MS]);
    if (!ok) {
        throw new RefusedError(
            `The person said no (or did not answer) to: ${what}. Do not try another way round it; ask them what they would prefer.`,
        );
    }
};

export const click = async (ref: string, tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    const element = await inject(tab.id, describeRef, [ref]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    await confirmed(tab.id, `click "${element.name === "" ? ref : element.name}"`, element.sensitive);
    const result = await inject(tab.id, clickRef, [ref]);
    if (!result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, `The agent clicked "${element.name === "" ? ref : element.name}"`);
    // The click may have navigated, in which case the new page is a different document with its own permission
    // question — asking again is what keeps a navigation from being a way around a grant.
    const after = await targetTab("read", tab.id).catch(() => undefined);
    return after === undefined ? `Clicked. The page then navigated somewhere this browser is not allowed to read.` : await pageText(after.id);
};

export const fill = async (ref: string, text: string, submit: boolean, tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    const element = await inject(tab.id, describeRef, [ref]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    // Submitting is the consequential half: typing into a box changes nothing until something sends it.
    await confirmed(
        tab.id,
        submit ? `fill in and submit this form` : `type into "${element.name === "" ? ref : element.name}"`,
        element.sensitive && submit,
    );
    const result = await inject(tab.id, fillRef, [ref, text, submit]);
    if (!result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, submit ? `The agent filled in and submitted a form` : `The agent typed into "${element.name === "" ? ref : element.name}"`);
    const after = await targetTab("read", tab.id).catch(() => undefined);
    return after === undefined ? `Typed. The page then navigated somewhere this browser is not allowed to read.` : await pageText(after.id);
};

export const selectOption = async (ref: string, values: string[], tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    const result = await inject(tab.id, selectRef, [ref, values]);
    if (!result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, `The agent chose an option`);
    return await pageText(tab.id);
};

// A key for the page as a whole. Confirmed only under "always": Enter in a focused field can submit, but the
// pairing of a key with an unknown focus is not something the page-side sensitivity test can judge, and a
// prompt on every Escape would train people to click through prompts.
export const pressKey = async (key: string, tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    await confirmed(tab.id, `press ${key}`, false);
    await inject(tab.id, pressKeyOnPage, [key]);
    announce(tab.id, `The agent pressed ${key}`);
    const after = await targetTab("read", tab.id).catch(() => undefined);
    return after === undefined ? `Pressed ${key}.` : await pageText(after.id);
};

export const scroll = async (direction: "up" | "down" | "left" | "right", amount: number, tabId?: number): Promise<string> => {
    // Scrolling is a read, not an act: it changes what is visible and nothing else, and requiring the acting
    // grant for it would make a read-only site unreadable past its first screen.
    const tab = await targetTab("read", tabId);
    await inject(tab.id, scrollPage, [direction, amount]);
    return await pageText(tab.id);
};

export const waitFor = async (options: { text?: string; textGone?: string; seconds: number }, tabId?: number): Promise<string> => {
    const tab = await targetTab("read", tabId);
    const seconds = Math.min(Math.max(options.seconds, 1), MAX_WAIT_SECONDS);
    const needle = options.text ?? options.textGone;
    if (needle === undefined) {
        throw new RefusedError(`Say what to wait for: "text" for something to appear, "textGone" for something to disappear.`);
    }
    const result = await inject(tab.id, waitForText, [needle, options.textGone !== undefined, seconds * 1000]);
    return `${result.message}\n\n${await pageText(tab.id)}`;
};

/* The visible tab as an image. Its own switch on the card, and its own reason for being off by default: the
 * page serialization above is a list this extension built, while a screenshot is whatever pixels that window
 * happens to be showing — a second monitor's worth of somebody's email, if that is what is on it. */
export const screenshot = async (): Promise<{ data: string; mimeType: string }> => {
    assertScope(await store.scopes(), "screenshot");
    const tab = await targetTab("read");
    const target = await chrome.tabs.get(tab.id);
    if (target.windowId === undefined) {
        throw new RefusedError(`That tab is not in a window this browser can capture.`);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "png" });
    announce(tab.id, `The agent took a screenshot`);
    return { data: dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" };
};

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

// Each page tool: get a permitted tab, run something in it, return the fresh page state so the model never has to
// guess whether an action landed. Every action also flashes a banner in the tab; a failed banner must never fail
// the action it describes.

// How long a confirmation panel waits before it counts as no.
const CONFIRM_TIMEOUT_MS = 120_000;
// Ceiling on wait_for; must not outlive the socket's own timeout.
const MAX_WAIT_SECONDS = 60;

// Runs an injected function in a tab and returns its result; see page/driver.ts for the serialization rule these
// functions follow.
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

// Renders the page via the shared vocabulary in @intentic/browser/page, so this browser and the sandbox's own read
// the same format.
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

// Navigating needs the acting scope but not a grant on the destination; reading what lands there needs the read
// grant, since the destination — not the source page — is the subject of this action.
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
    // Give the navigation a moment to commit before reading the tab back.
    await sleep(600);
    try {
        const permitted = await targetTab("read", tab.id);
        announce(permitted.id, `The agent opened this page`);
        return await pageText(permitted.id);
    } catch (error) {
        return `Opened ${target}. ${errorMessage(error)}`;
    }
};

// Asks the person when the switches require it. The question renders in the page, next to what it's about; an
// unanswered question is a no (page/driver.ts).
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
    // Re-checks permission after the click: a navigation must not be a way around a grant.
    const after = await targetTab("read", tab.id).catch(() => undefined);
    return after === undefined ? `Clicked. The page then navigated somewhere this browser is not allowed to read.` : await pageText(after.id);
};

export const fill = async (ref: string, text: string, submit: boolean, tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    const element = await inject(tab.id, describeRef, [ref]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    // Submitting, not typing, is what needs confirmation.
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

// Sends a key to the page. Always confirmed: a key's effect on an unknown focus target can't be judged for
// sensitivity, and prompting only sometimes would train people to click through.
export const pressKey = async (key: string, tabId?: number): Promise<string> => {
    const tab = await targetTab("act", tabId);
    await confirmed(tab.id, `press ${key}`, false);
    await inject(tab.id, pressKeyOnPage, [key]);
    announce(tab.id, `The agent pressed ${key}`);
    const after = await targetTab("read", tab.id).catch(() => undefined);
    return after === undefined ? `Pressed ${key}.` : await pageText(after.id);
};

export const scroll = async (direction: "up" | "down" | "left" | "right", amount: number, tabId?: number): Promise<string> => {
    // Scrolling only needs read access; it changes what's visible, not the page.
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

// Captures the visible tab as an image, gated by its own scope: unlike the page snapshot, a screenshot shows
// whatever pixels are on screen, not just this extension's own list.
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

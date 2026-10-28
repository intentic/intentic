import { sleep, within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { renderPage, toPageState } from "@intentic/browser/page";
import {
    type ActionResult,
    clickRef,
    collectPage,
    describeRef,
    fillRef,
    pressKeyOnPage,
    readPageText,
    scrollPage,
    selectRef,
    waitForText,
} from "../../page/driver.js";
import { flashBanner } from "../../page/overlay.js";
import { isAgentWindow, type Opened, openInAgentWindow, ownWindow } from "../agent-window.js";
import { askPerson } from "../asking.js";
import { APPROVAL_HOLD_MS, assertRunning, assertScope, needsConfirm, RefusedError } from "../policy.js";
import { type SandboxKey, store } from "../store.js";
import { type TargetTab, targetTab } from "./tab-access.js";
import { fitCapture } from "./fit-capture.js";
import { untilTabLoaded } from "./tab-loaded.js";

// Each page tool: get a permitted tab, run something in it, return the fresh page state so the model never has to
// guess whether an action landed. Every action also flashes a banner in the tab; a failed banner must never fail
// the action it describes.

// How long a confirmation panel waits before it counts as no.
const CONFIRM_TIMEOUT_MS = 120_000;
// Ceiling on wait_for; must not outlive the socket's own timeout.
const MAX_WAIT_SECONDS = 60;

// Runs an injected function in a tab and returns its result; see page/driver.ts for the serialization rule these
// functions follow. Chrome answers `null` rather than nothing when the function threw in the page or the frame went away
// before its promise settled, so both read as a page that did not answer, never as a result to read fields off.
export const inject = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Result, args: Args): Promise<Awaited<Result>> => {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    if (frame?.result === undefined || frame.result === null) {
        throw new RefusedError(`That page did not answer. It may have navigated mid-call, or it may be a page no extension can touch.`);
    }
    return frame.result;
};

export const announce = (tabId: number, message: string): void => {
    void chrome.scripting.executeScript({ target: { tabId }, func: flashBanner, args: [message] }).catch(() => undefined);
};

// Renders the page via the shared vocabulary in @intentic/browser/page, so this browser and the sandbox's own read
// the same format.
const pageText = async (tabId: number): Promise<string> => {
    const snapshot = await inject(tabId, collectPage, []);
    const rendered = renderPage(toPageState(snapshot), snapshot.truncated);
    return snapshot.loading ? `${rendered}\n(the page is still loading: take another snapshot in a moment if what you need is missing)` : rendered;
};

export const snapshot = async (from: SandboxKey, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "read", tabId);
    return await pageText(tab.id);
};

export const readable = async (from: SandboxKey, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "read", tabId);
    const page = await inject(tab.id, readPageText, []);
    return [
        `Page: ${page.title === "" ? "(untitled)" : page.title}`,
        page.url,
        ``,
        page.text === "" ? `(this page has no readable text: try a snapshot, it may be an app rather than a document)` : page.text,
        ...(page.truncated ? [`…(truncated)`] : []),
    ].join("\n");
};

// The person chose to have the agent work in their own tab: the one in front of them, pointed somewhere else, or a new
// one in front in their window.
const openInFront = async (target: string, where: "current" | "new"): Promise<Opened> => {
    const active = where === "new" ? undefined : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (where === "current" && active?.id === undefined) {
        throw new RefusedError(`This browser has no active tab to point somewhere.`);
    }
    const tab =
        where === "new" || active?.id === undefined
            ? await chrome.tabs.create({ url: target, active: true })
            : await chrome.tabs.update(active.id, { url: target });
    return { tab, created: false };
};

// Said once, with the page, when the agent's window has just opened: so it can tell the person where its work is.
const OPENED_WINDOW = `(This opened in a window of your own, behind the person's, so what they are doing is not interrupted. Tools given no \`tab\` now work here.)`;

// Navigating needs the acting scope but not a grant on the destination; reading what lands there needs the read
// grant, since the destination — not the source page — is the subject of this action.
export const openUrl = async (from: SandboxKey, url: string, where: "current" | "new"): Promise<string> => {
    const [scopes, paused] = await Promise.all([store.scopes(from), store.paused()]);
    assertRunning(paused);
    assertScope(scopes, "act");
    const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const { tab, created } = (await ownWindow()) ? await openInAgentWindow(from, target, where === "new") : await openInFront(target, where);
    const opened = created ? `Opened ${target}. ${OPENED_WINDOW}` : `Opened ${target}.`;
    if (tab?.id === undefined) {
        return opened;
    }
    await untilTabLoaded(tab.id);
    try {
        const permitted = await targetTab(from, "read", tab.id);
        announce(permitted.id, `The agent opened this page`);
        const page = await pageText(permitted.id);
        return created ? `${page}\n\n${OPENED_WINDOW}` : page;
    } catch (error) {
        return `${opened} ${errorMessage(error)}`;
    }
};

// How the action came to be allowed: not a question at all, the person's yes just now, or a yes they gave to this
// same action a moment ago that had nothing to land on (policy.ts KeptApproval).
type Consent = "unasked" | "asked" | "kept";

// Asks the person when the switches require it. The question renders in the page, next to what it's about; an
// unanswered question is a no (page/overlay.ts).
const confirmed = async (from: SandboxKey, tab: TargetTab, what: string, sensitive: boolean): Promise<Consent> => {
    const scopes = await store.scopes(from);
    if (!needsConfirm(scopes, sensitive)) {
        return "unasked";
    }
    if (await store.takeApproval({ tabId: tab.id, url: tab.url, what }, Date.now())) {
        return "kept";
    }
    const ok = await askPerson(from, tab, `Your agent wants to ${what}. Allow it?`, CONFIRM_TIMEOUT_MS);
    if (!ok) {
        throw new RefusedError(
            `The person said no (or did not answer) to: ${what}. Do not try another way round it; ask them what they would prefer.`,
        );
    }
    return "asked";
};

// What a click that found its element gone tells the agent. After the person's yes, the likely story is a menu or
// popover the page closed while they decided; saying only "gone" had the agent retry into the same question and the
// same loss, so the yes is kept for one retry of exactly this click.
const failed = async (tab: TargetTab, what: string, consent: Consent, result: ActionResult): Promise<RefusedError> => {
    if (result.gone !== true || consent !== "asked") {
        return new RefusedError(result.message);
    }
    await store.keepApproval({ tabId: tab.id, url: tab.url, what, at: Date.now() });
    return new RefusedError(
        `Nothing happened: the person allowed it (${what}), but by then the element was gone from the page; the menu or popup it was in most likely closed while they were being asked. Their yes is kept for ${Math.round(APPROVAL_HOLD_MS / 60_000)} minutes, for one retry of exactly this click in this tab: open the menu again, take a fresh snapshot, and click the same element. They will not be asked again for it.`,
    );
};

export const click = async (from: SandboxKey, ref: string, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    // The click lands on the element described here, not on whatever the ref names after the person decides.
    const pin = crypto.randomUUID();
    const element = await inject(tab.id, describeRef, [ref, pin]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    const what = `click "${element.name === "" ? ref : element.name}"`;
    const consent = await confirmed(from, tab, what, element.sensitive);
    const result = await inject(tab.id, clickRef, [ref, pin]);
    if (!result.ok) {
        throw await failed(tab, what, consent, result);
    }
    announce(tab.id, `The agent clicked "${element.name === "" ? ref : element.name}"`);
    // Re-checks permission after the click: a navigation must not be a way around a grant.
    const after = await targetTab(from, "read", tab.id).catch(() => undefined);
    return after === undefined ? `Clicked. The page then navigated somewhere this browser is not allowed to read.` : await pageText(after.id);
};

export const fill = async (from: SandboxKey, ref: string, text: string, submit: boolean, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    const pin = crypto.randomUUID();
    const element = await inject(tab.id, describeRef, [ref, pin]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    // Submitting, not typing, is what needs confirmation.
    // No yes is kept here when the field is gone: the question names no field ("this form"), so a kept one could
    // not tell this form from the next.
    await confirmed(
        from,
        tab,
        submit ? `fill in and submit this form` : `type into "${element.name === "" ? ref : element.name}"`,
        element.sensitive && submit,
    );
    const result = await inject(tab.id, fillRef, [ref, text, submit, pin]);
    if (!result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, submit ? `The agent filled in and submitted a form` : `The agent typed into "${element.name === "" ? ref : element.name}"`);
    const after = await targetTab(from, "read", tab.id).catch(() => undefined);
    return after === undefined ? `Typed. The page then navigated somewhere this browser is not allowed to read.` : await pageText(after.id);
};

export const selectOption = async (from: SandboxKey, ref: string, values: string[], tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    const result = await inject(tab.id, selectRef, [ref, values]);
    if (!result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, `The agent chose an option`);
    return await pageText(tab.id);
};

// Sends a key to the page. Always confirmed: a key's effect on an unknown focus target can't be judged for
// sensitivity, and prompting only sometimes would train people to click through.
export const pressKey = async (from: SandboxKey, key: string, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    await confirmed(from, tab, `press ${key}`, false);
    await inject(tab.id, pressKeyOnPage, [key]);
    announce(tab.id, `The agent pressed ${key}`);
    const after = await targetTab(from, "read", tab.id).catch(() => undefined);
    return after === undefined ? `Pressed ${key}.` : await pageText(after.id);
};

export const scroll = async (from: SandboxKey, direction: "up" | "down" | "left" | "right", amount: number, tabId?: number): Promise<string> => {
    // Scrolling only needs read access; it changes what's visible, not the page.
    const tab = await targetTab(from, "read", tabId);
    await inject(tab.id, scrollPage, [direction, amount]);
    return await pageText(tab.id);
};

export const waitFor = async (from: SandboxKey, options: { text?: string; textGone?: string; seconds: number }, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "read", tabId);
    const seconds = Math.min(Math.max(options.seconds, 1), MAX_WAIT_SECONDS);
    const needle = options.text ?? options.textGone;
    if (needle === undefined) {
        throw new RefusedError(`Say what to wait for: "text" for something to appear, "textGone" for something to disappear.`);
    }
    const result = await inject(tab.id, waitForText, [needle, options.textGone !== undefined, seconds * 1000]);
    return `${result.message}\n\n${await pageText(tab.id)}`;
};

// How long a capture may take before it counts as not coming: a minimized window's capture never settled at all in
// Brave 156 (2026-10-28), and the call must not hold the socket until its own timeout.
const CAPTURE_CAP_MS = 8000;
// How long a window restored for a capture is given to draw again before it is read.
const RESTORE_SETTLE_MS = 250;

// Captures a tab as an image, gated by its own scope: unlike the page snapshot, a screenshot shows whatever pixels are
// on screen, not just this extension's own list. Chrome captures what a WINDOW shows, so the tab must be the one in
// front in its own window, or the picture would be of another page, very likely one of the person's. The agent's
// window behind theirs captures as it is; minimized it draws nothing, so it is restored without focus (Brave keeps it
// behind their window, measured), read, and minimized again.
export const screenshot = async (from: SandboxKey, tabId?: number, capMs: number = CAPTURE_CAP_MS): Promise<{ data: string; mimeType: string }> => {
    assertScope(await store.scopes(from), "screenshot");
    const tab = await targetTab(from, "read", tabId);
    const target = await chrome.tabs.get(tab.id);
    if (target.windowId === undefined) {
        throw new RefusedError(`That tab is not in a window this browser can capture.`);
    }
    if (target.active !== true) {
        throw new RefusedError(
            `Tab ${tab.id} is not the one showing in its window, and a screenshot is of what a window shows, so it would be another page. Use snapshot or read for it instead.`,
        );
    }
    const windowId = target.windowId;
    const window = await chrome.windows.get(windowId);
    const restore = window.state === "minimized" && (await isAgentWindow(windowId, from));
    if (window.state === "minimized" && !restore) {
        throw new RefusedError(`That tab's window is minimized, so there is nothing on screen to capture. Use snapshot or read for it instead.`);
    }
    if (restore) {
        await chrome.windows.update(windowId, { state: "normal", focused: false });
        await sleep(RESTORE_SETTLE_MS);
    }
    try {
        const dataUrl = await within(chrome.tabs.captureVisibleTab(windowId, { format: "png" }), capMs, undefined);
        if (dataUrl === undefined) {
            throw new RefusedError(
                `The browser did not hand over a picture of the page within ${Math.round(capMs / 1000)} seconds. Use snapshot or read instead; a screenshot may work again once the page has been on screen.`,
            );
        }
        announce(tab.id, `The agent took a screenshot`);
        return { data: await fitCapture(dataUrl), mimeType: "image/png" };
    } finally {
        if (restore) {
            // allow(silent-catch): the person may have closed or moved the window meanwhile; the picture is taken either way
            await chrome.windows.update(windowId, { state: "minimized" }).catch(() => undefined);
        }
    }
};

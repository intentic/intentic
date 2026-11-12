import { sleep, within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { renderPage, toPageState } from "@intentic/browser/page";
import {
    type ActionResult,
    clickRef,
    collectPage,
    describeRef,
    type DocumentMark,
    markDocument,
    pressKeyOnPage,
    readPageText,
    scrollPage,
    selectRef,
} from "../../page/driver.js";
import { checkField, focusField, pressEnterInField, typeRich, typeValue } from "../../page/typing.js";
import { flashBanner, OVERLAY_LOOK } from "../../page/overlay.js";
import { isAgentWindow, type Opened, openInAgentWindow, ownWindow } from "../agent-window.js";
import { askPerson } from "../asking.js";
import { APPROVAL_HOLD_MS, assertRunning, assertScope, needsConfirm, originPattern, RefusedError } from "../policy.js";
import { type SandboxKey, store } from "../store.js";
import { type TargetTab, targetTab } from "./tab-access.js";
import { fitCapture } from "./fit-capture.js";
import { untilTabLoaded, untilTabSettled } from "./tab-loaded.js";
import { type WaitAsk, waitOnPage } from "./page-wait.js";

// Each page tool: get a permitted tab, run something in it, return the fresh page state so the model never has to
// guess whether an action landed. Every action also flashes a banner in the tab; a failed banner must never fail
// the action it describes.

// How long a confirmation panel waits before it counts as no.
const CONFIRM_TIMEOUT_MS = 120_000;
// Ceiling on wait_for, in seconds: nine minutes, for an image or a video a site takes minutes to make. The sandbox waits
// on any one call to this browser for ten (peers/webext-call-deadline.ts), which leaves at least half a minute for the
// page read after the wait and the trip back, even when a frozen page took the wait's grace (page-wait.ts); the agent's
// own MCP client waits longer still (peers/peer-tools.ts).
export const MAX_WAIT_SECONDS = 540;

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
    void chrome.scripting.executeScript({ target: { tabId }, func: flashBanner, args: [message, OVERLAY_LOOK] }).catch(() => undefined);
};

// Renders the page via the shared vocabulary in @intentic/browser/page, so this browser and the sandbox's own read
// the same format.
const rendered = (snapshot: Awaited<ReturnType<typeof collectPage>>): string => {
    const page = renderPage(toPageState(snapshot), snapshot.truncated);
    return snapshot.loading ? `${page}\n(the page is still loading: take another snapshot in a moment if what you need is missing)` : page;
};

const pageText = async (tabId: number): Promise<string> => rendered(await inject(tabId, collectPage, []));

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

// ---- Actions that say what became of them ----
// An action can change the page under the call that made it: ChatGPT's Send routes from / to /c/<id>, a link loads
// another document, a form posts. Chrome then answers the injected action with null or throws, which used to come back
// as "That page did not answer" although the message HAD been sent, and the agent sent it again (2026-11). So every
// action notes the page's address and document first (markDocument), and afterwards says what is observable: the
// page's own answer, an address that changed, a document that was replaced, and when none of that can be seen, that
// the outcome is UNKNOWN, so the agent looks before it repeats anything. The page is read back only after the
// destination's permission is checked again: a navigation must never be a way around a grant.

// How long the page is given to react to an action that answered before it is read back: a framework's render, a
// route it changes at once.
const ANSWERED_SETTLE_MS = 150;
// How long after an action whose page gave no answer before looking where the tab is: a navigation the action started
// has begun by then, and Chrome reports the tab as loading until it lands.
const UNANSWERED_SETTLE_MS = 500;

// Ordinary https pages that no extension may script: Chrome's and Edge's extension stores. Named here so the agent is
// told so plainly, rather than meeting a page that "did not answer".
const STORE_PAGES = [/^https:\/\/chromewebstore\.google\.com\//, /^https:\/\/chrome\.google\.com\/webstore/, /^https:\/\/microsoftedge\.microsoft\.com\/addons/];

// An injected function's answer, or undefined when the page gave none. Unlike inject, nothing is thrown: for an
// action, no answer is a fact to explain, not a failure. Chrome answers null when the function threw or its frame
// went away before it settled, and throws when the frame was removed mid-call or the tab closed.
const answerOf = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Result, args: Args): Promise<Awaited<Result> | undefined> => {
    try {
        const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
        return frame?.result ?? undefined;
    } catch {
        // allow(silent-catch): every way Chrome fails here means the page gave no answer, which afterAction explains
        return undefined;
    }
};

// Where the page stood before an action. Nothing has been done yet, so a page that does not answer here is said to
// be untouched.
const beforeAction = async (tab: TargetTab): Promise<DocumentMark> => {
    if (STORE_PAGES.some((page) => page.test(tab.url))) {
        throw new RefusedError(`This is the browser's extension store, a page no extension may touch, so nothing was done there.`);
    }
    const mark = await answerOf(tab.id, markDocument, [crypto.randomUUID()]);
    if (mark === undefined) {
        throw new RefusedError(`The page did not answer, so nothing was done. It may be in the middle of loading: take a snapshot in a moment, then try again.`);
    }
    return mark;
};

// What an action was, for the sentence that reports it: `did` once it is known to have landed ("Clicked \"Send\""),
// `attempt` while that is unknown ("the click on \"Send\""), and what the page said beside it.
interface Done {
    readonly answered: boolean;
    readonly did: string;
    readonly attempt: string;
    readonly note?: string | undefined;
}

// The page after an action and the address it was read at, only on the site whose permission was just checked: the
// page can move again between the check and the read (a redirect a moment after load), and what it moved to is not
// read or named. A read that fails or lands elsewhere is tried once more after the tab settles, with the permission
// asked again, since the page it finds then may be another one.
const pageAfter = async (from: SandboxKey, permitted: TargetTab): Promise<{ readonly page: string; readonly url: string }> => {
    const read = async (tab: TargetTab): Promise<{ readonly page: string; readonly url: string }> => {
        const collected = await inject(tab.id, collectPage, []);
        if (originPattern(collected.url) !== originPattern(tab.url)) {
            throw new RefusedError(`The page moved again while it was being read.`);
        }
        return { page: rendered(collected), url: collected.url };
    };
    try {
        return await read(permitted);
    } catch {
        await sleep(UNANSWERED_SETTLE_MS);
        await untilTabSettled(permitted.id);
        try {
            return await read(await targetTab(from, "read", permitted.id));
        } catch {
            // allow(silent-catch): what refused the read is said as a page that could not be shown, never as its address
            return { page: `(The page could not be read just now: it is still loading, or it moved again. Take a snapshot in a moment.)`, url: permitted.url };
        }
    }
};

// The tab after an action, when the agent may no longer read it: moved to a site it was not given, or the browser
// paused meanwhile. Chrome hides the address of a site this extension holds no grant for, so a changed or hidden
// address is a move, and its address is never repeated.
const unreadable = async (tabId: number, before: DocumentMark, done: Done, reason: string): Promise<string> => {
    const lead = done.answered ? done.did : `UNKNOWN whether ${done.attempt} took effect`;
    // allow(silent-catch): a closed tab is answered as closed
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined) {
        return done.answered ? `${done.did}; the tab then closed.` : `${lead}: the tab closed before it could be checked.`;
    }
    // Still on the page it was acted on, so the refusal names nothing the agent did not already have.
    if (tab.url === before.url) {
        return `${lead}, but the page cannot be read back: ${reason}`;
    }
    // A hidden or changed address: a move to a site not given, or the grant taken back. The refusal would name the
    // destination's host, so it is left out.
    return `${lead}; the page can no longer be read: it moved somewhere this browser is not allowed to read, or its permission was taken back, so it is not shown. Take a snapshot to see where it stands, or ask the person.`;
};

const afterAction = async (from: SandboxKey, tabId: number, before: DocumentMark, done: Done): Promise<string> => {
    await sleep(done.answered ? ANSWERED_SETTLE_MS : UNANSWERED_SETTLE_MS);
    await untilTabSettled(tabId);
    let permitted: TargetTab;
    try {
        permitted = await targetTab(from, "read", tabId);
    } catch (error) {
        return await unreadable(tabId, before, done, errorMessage(error));
    }
    // Only the mark is taken from this look: the address said is the one the page was read at, under its permission.
    const now = await answerOf(permitted.id, markDocument, [crypto.randomUUID()]);
    const { page, url } = await pageAfter(from, permitted);
    const moved = url !== before.url;
    const said = done.note === undefined ? done.did : `${done.did} (${done.note})`;
    if ((now !== undefined && now.mark !== before.mark) || (moved && now === undefined)) {
        return `${said}; the page then ${moved ? `moved to ${url}` : `reloaded`} (page below).\n\n${page}`;
    }
    if (moved) {
        return `${said}; the page's address then changed to ${url} without loading a new page, as a single-page app changes views. References from earlier snapshots are stale: use the ones below.\n\n${page}`;
    }
    if (!done.answered) {
        return `UNKNOWN whether ${done.attempt} took effect: the page never reported back, and it is still on the same address and document. Check the page below for whether it happened before doing it again; repeating it blindly may do it twice.\n\n${page}`;
    }
    return `${said}.\n\n${page}`;
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

// beforeAction after the person's yes: a page that does not answer before anything was done has not used the yes,
// so it is kept for one retry of exactly this action in this tab, as failed() keeps one whose element was gone.
const beforeConsented = async (tab: TargetTab, what: string, consent: Consent): Promise<DocumentMark> => {
    try {
        return await beforeAction(tab);
    } catch (error) {
        if (consent === "unasked") {
            throw error;
        }
        await store.keepApproval({ tabId: tab.id, url: tab.url, what, at: Date.now() });
        throw new RefusedError(
            `${errorMessage(error)} The person's yes (${what}) is kept for ${Math.round(APPROVAL_HOLD_MS / 60_000)} minutes, for one retry of exactly this in this tab; they will not be asked again for it.`,
        );
    }
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
    const named = element.name === "" ? ref : element.name;
    const what = `click "${named}"`;
    const consent = await confirmed(from, tab, what, element.sensitive);
    const before = await beforeConsented(tab, what, consent);
    const result = await answerOf(tab.id, clickRef, [ref, pin]);
    if (result !== undefined && !result.ok) {
        throw await failed(tab, what, consent, result);
    }
    announce(tab.id, `The agent clicked "${named}"`);
    return await afterAction(from, tab.id, before, { answered: result !== undefined, did: `Clicked "${named}"`, attempt: `the click on "${named}"` });
};

// Fill's steps after the field is focused (page/typing.ts): put the text in, read it back, press Enter. The first
// step that does not answer, or answers no, ends it there.
const typeInto = async (tabId: number, ref: string, text: string, rich: boolean, submit: boolean): Promise<ActionResult | undefined> => {
    const typed = await answerOf(tabId, rich ? typeRich : typeValue, [text]);
    if (typed?.ok !== true) {
        return typed;
    }
    const checked = await answerOf(tabId, checkField, [ref, text]);
    if (checked?.ok !== true || !submit) {
        return checked;
    }
    const pressed = await answerOf(tabId, pressEnterInField, []);
    return pressed?.ok === true ? { ...checked, message: pressed.message } : pressed;
};

export const fill = async (from: SandboxKey, ref: string, text: string, submit: boolean, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    const pin = crypto.randomUUID();
    const element = await inject(tab.id, describeRef, [ref, pin]);
    if (!element.ok) {
        throw new RefusedError(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    const named = element.name === "" ? ref : element.name;
    // Submitting, not typing, is what needs confirmation.
    // No yes is kept here when the field is gone: the question names no field ("this form"), so a kept one could
    // not tell this form from the next.
    await confirmed(from, tab, submit ? `fill in and submit this form` : `type into "${named}"`, element.sensitive && submit);
    const before = await beforeAction(tab);
    const focused = await inject(tab.id, focusField, [ref, pin]);
    if (!focused.ok) {
        throw new RefusedError(focused.message);
    }
    const result = await typeInto(tab.id, ref, text, focused.rich === true, submit);
    if (result !== undefined && !result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, submit ? `The agent filled in and submitted a form` : `The agent typed into "${named}"`);
    return await afterAction(from, tab.id, before, {
        answered: result !== undefined,
        did: submit ? `Typed into "${named}" and pressed Enter` : `Typed into "${named}"`,
        attempt: submit ? `typing into "${named}" and pressing Enter` : `typing into "${named}"`,
        note: result?.note,
    });
};

export const selectOption = async (from: SandboxKey, ref: string, values: string[], tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    const before = await beforeAction(tab);
    const result = await answerOf(tab.id, selectRef, [ref, values]);
    if (result !== undefined && !result.ok) {
        throw new RefusedError(result.message);
    }
    announce(tab.id, `The agent chose an option`);
    const chosen = values.map((value) => `"${value}"`).join(", ");
    return await afterAction(from, tab.id, before, { answered: result !== undefined, did: `Chose ${chosen} in ${ref}`, attempt: `choosing ${chosen} in ${ref}` });
};

// Sends a key to the page. Always confirmed: a key's effect on an unknown focus target can't be judged for
// sensitivity, and prompting only sometimes would train people to click through.
export const pressKey = async (from: SandboxKey, key: string, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "act", tabId);
    const consent = await confirmed(from, tab, `press ${key}`, false);
    const before = await beforeConsented(tab, `press ${key}`, consent);
    const result = await answerOf(tab.id, pressKeyOnPage, [key]);
    announce(tab.id, `The agent pressed ${key}`);
    return await afterAction(from, tab.id, before, { answered: result !== undefined, did: `Pressed ${key}`, attempt: `pressing ${key}` });
};

export const scroll = async (from: SandboxKey, direction: "up" | "down" | "left" | "right", amount: number, tabId?: number): Promise<string> => {
    // Scrolling only needs read access; it changes what's visible, not the page.
    const tab = await targetTab(from, "read", tabId);
    await inject(tab.id, scrollPage, [direction, amount]);
    return await pageText(tab.id);
};

// Waits in the tab until what the agent asked for is so, or `seconds` pass (tools/page-wait.ts), then answers with
// which, and the page. The page is read through the read grant again, since a page that navigated meanwhile may be on a
// site this browser may not read.
export const waitFor = async (from: SandboxKey, ask: WaitAsk, tabId?: number): Promise<string> => {
    const tab = await targetTab(from, "read", tabId);
    return await waitOnPage(tab.id, ask, async (id) => await pageText((await targetTab(from, "read", id)).id));
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

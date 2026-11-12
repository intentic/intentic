import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { type WaitConditions, type WaitRound, waitRound, watchPage } from "../../page/waiting.js";
import { RefusedError } from "../policy.js";
import { untilTabLoaded } from "./tab-loaded.js";

// wait_for's half in the worker: installs a watch in the tab (page/waiting.ts), then asks it round after round until
// every condition holds or the wait's own deadline passes, and says which.
//
// Why rounds rather than one injected wait of up to nine minutes. The worker stays alive while it waits: the sandbox's
// heartbeat (WEBEXT_HEARTBEAT_MS, 20 s) arrives over the socket, and since Chrome 116 (this extension's minimum) a
// WebSocket message resets the worker's 30 s idle timer, as does every extension API call. What Chrome does not promise
// is a single API call or event that runs longer than 5 minutes: its documented rule is to stop a worker whose one
// request takes that long. A round of at most ROUND_MS keeps every executeScript call far inside that, and each round's
// call is itself activity. The watch carries the quiet stretch across rounds, so nothing is lost between them.

// How long one round runs in the page.
export const ROUND_MS = 25_000;
// How long past its own end a round may take to come back before the page counts as not answering. A covered window's
// timers run about once a second, so a round ends at most a second late; a page that has not answered in this long is
// frozen or gone.
const ROUND_GRACE_MS = 15_000;
// How long installing a watch, or asking a page that went quiet where its wait stands, may take.
const PROBE_MS = 5_000;

// What the agent asked for, as wait_for takes it: seconds, and quietFor in seconds.
export interface WaitAsk {
    readonly text?: string | undefined;
    readonly textGone?: string | undefined;
    readonly quietFor?: number | undefined;
    readonly seconds: number;
}

// The page as the agent reads it after the wait, and refused when the tab is now on a site it may not read.
export type PageReader = (tabId: number) => Promise<string>;

// Whole seconds below two minutes, minutes and seconds above: how a person reads a wait.
const spoken = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 120) {
        return `${seconds} s`;
    }
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
};

// What an injection came back as. `silent` is a page that did not answer in time (frozen, or hung); `lost` is one that
// went away under the call (navigated, closed, or now a page this extension may not touch) or answered nothing.
type Ran<T> = { readonly kind: "answered"; readonly value: T } | { readonly kind: "silent" } | { readonly kind: "lost"; readonly why: string };

const run = async <Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Result, args: Args, capMs: number): Promise<Ran<Awaited<Result>>> => {
    const call = chrome.scripting.executeScript({ target: { tabId }, func, args }).then(
        ([frame]): Ran<Awaited<Result>> =>
            frame?.result === undefined || frame.result === null ? { kind: "lost", why: "no answer" } : { kind: "answered", value: frame.result },
        (error: Error): Ran<Awaited<Result>> => ({ kind: "lost", why: errorMessage(error) }),
    );
    return await within(call, capMs, { kind: "silent" } as const);
};

const conditionsOf = (ask: WaitAsk): WaitConditions => ({
    text: ask.text,
    textGone: ask.textGone,
    quietMs: ask.quietFor === undefined ? undefined : ask.quietFor * 1000,
});

// The conditions as they were met, in the order they were asked.
const metSaying = (ask: WaitAsk, waitedMs: number): string => {
    const parts = [
        ...(ask.text === undefined ? [] : [`"${ask.text}" appeared`]),
        ...(ask.textGone === undefined ? [] : [`"${ask.textGone}" is gone`]),
        ...(ask.quietFor === undefined ? [] : [`the page has not changed for ${ask.quietFor} s`]),
    ];
    return waitedMs < 1000 ? `Already so when asked: ${parts.join("; ")}.` : `After ${spoken(waitedMs)}: ${parts.join("; ")}.`;
};

// What was still not so when the wait ran out, then what was, then what to do next.
const unmetSaying = (ask: WaitAsk, round: WaitRound, waitedMs: number): string => {
    const unmet: string[] = [];
    const met: string[] = [];
    if (ask.text !== undefined) {
        (round.textShown === true ? met : unmet).push(round.textShown === true ? `"${ask.text}" is on the page` : `"${ask.text}" has not appeared`);
    }
    if (ask.textGone !== undefined) {
        (round.textGoneShown === true ? unmet : met).push(round.textGoneShown === true ? `"${ask.textGone}" is still on the page` : `"${ask.textGone}" is gone`);
    }
    const restless = ask.quietFor !== undefined && round.stillMs < ask.quietFor * 1000;
    if (restless) {
        const busy = round.busy.length === 0 ? "" : ` What kept changing: ${round.busy.join("; ")}.`;
        unmet.push(
            `the page never stayed unchanged for ${ask.quietFor} s (its longest still stretch was ${spoken(round.longestStillMs)}, and it last changed ${spoken(round.stillMs)} ago).${busy}`,
        );
    } else if (ask.quietFor !== undefined) {
        met.push(`the page has not changed for ${spoken(round.stillMs)}`);
    }
    return [
        `Stopped waiting after ${spoken(waitedMs)}, with the page not there yet. Still not so: ${unmet.join("; ")}`,
        ...(met.length === 0 ? [] : [`Already so: ${met.join("; ")}.`]),
        `This is the page as it stands now: a timeout is an answer, not a failure. If it is still working, wait again (seconds goes up to 540).${ 
            restless ? ` If something on it never stops changing (a clock, a counter, streaming text), wait for the text that marks the end instead of quietFor.` : ""}`,
    ].join("\n");
};

// The page reads after `said`, or `said` with why it cannot be read.
const withPage = async (said: string, tabId: number, read: PageReader): Promise<string> => {
    try {
        return `${said}\n\n${await read(tabId)}`;
    } catch (error) {
        return `${said} ${errorMessage(error)}`;
    }
};

// The document the wait watched was replaced: said with where the tab is now and that page as it stands. Where it went is
// named only once its page reads, since the read checks the grant again (tools/page.ts): a page the agent may not read
// is not named, as list_tabs does not name one (tools/tabs.ts), whatever address Chrome hands over; its refusal says
// what may be said about it.
const moved = async (tabId: number, from: string, waitedMs: number, read: PageReader): Promise<string> => {
    // allow(silent-catch): a tab gone by now is said without where it went, and the read below says why
    const now = await chrome.tabs.get(tabId).catch(() => undefined);
    const ended = `The wait ended after ${spoken(waitedMs)} because the page was replaced`;
    const after = `Nothing was waited for on the new page. If what you expect belongs to it, wait again.`;
    let page: string;
    try {
        page = await read(tabId);
    } catch (error) {
        return `${ended}: it navigated away from ${from}. ${after} ${errorMessage(error)}`;
    }
    const where = now?.url === undefined ? `navigated away from ${from}` : now.url === from ? `reloaded (${now.url})` : `navigated from ${from} to ${now.url}`;
    return `${ended}: it ${where}. ${after}\n\n${page}`;
};

// A round that did not come back: the tab closed, was unloaded, navigated, or the page froze. Asks the page once more
// where the wait stands, after any load in flight, and answers with what is true.
const afterSilence = async (tabId: number, id: string, conditions: WaitConditions, waitedMs: number): Promise<WaitRound | "replaced"> => {
    // allow(silent-catch): Chrome rejects get() for a closed tab, and a closed tab is the answer given just below
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined) {
        throw new RefusedError(`The tab was closed after ${spoken(waitedMs)} of waiting, so there is nothing left to wait on.`);
    }
    if (tab.discarded === true) {
        throw new RefusedError(
            `The browser unloaded this tab to save memory after ${spoken(waitedMs)} of waiting, so its page is gone until it is shown or reloaded. Open its address again, then wait again.`,
        );
    }
    if (tab.status === "loading") {
        await untilTabLoaded(tabId);
    }
    const probe = await run(tabId, waitRound, [id, conditions, 0, false], PROBE_MS);
    if (probe.kind === "silent") {
        throw new RefusedError(
            `The page stopped answering after ${spoken(waitedMs)} of waiting: the browser may have frozen it, which it does to pages left in the background. Take a snapshot to see whether it wakes, then wait again.`,
        );
    }
    return probe.kind === "lost" || probe.value.state === "replaced" ? "replaced" : probe.value;
};

// Waits on tab `tabId` until every condition in `ask` holds or `ask.seconds` pass, and answers with which, then the page.
export const waitOnPage = async (tabId: number, ask: WaitAsk, read: PageReader): Promise<string> => {
    // At least one condition, and seconds within 1..540: wait_for's schema refuses anything else (mcp.ts).
    const conditions = conditionsOf(ask);
    const id = crypto.randomUUID();
    const started = Date.now();
    const deadline = started + ask.seconds * 1000;
    const watching = await run(tabId, watchPage, [id], PROBE_MS);
    if (watching.kind !== "answered") {
        throw new RefusedError(`That page did not answer. It may have navigated just now, or it may be a page no extension can touch: take a snapshot.`);
    }
    for (;;) {
        const left = deadline - Date.now();
        const last = left <= ROUND_MS;
        const roundMs = Math.max(0, Math.min(left, ROUND_MS));
        const ran = await run(tabId, waitRound, [id, conditions, roundMs, last], roundMs + ROUND_GRACE_MS);
        const round = ran.kind === "answered" && ran.value.state !== "replaced" ? ran.value : await afterSilence(tabId, id, conditions, Date.now() - started);
        if (round === "replaced" || round.state === "replaced") {
            return await moved(tabId, watching.value.url, Date.now() - started, read);
        }
        if (round.state === "met") {
            return await withPage(metSaying(ask, Date.now() - started), tabId, read);
        }
        // The last round stopped its watch, so another would find none and read as the page replaced.
        if (last) {
            return await withPage(unmetSaying(ask, round, Date.now() - started), tabId, read);
        }
    }
};

import type { McpTool } from "@intentic/sandbox-contract/peer-mcp-server";
import type { JsonValue } from "@intentic/base/json";
import { json, record, string } from "zod";
import { agentWindow, openInAgentWindow, ownWindow } from "../agent-window.js";
import { decide, originPattern, RefusedError } from "../policy.js";
import { DECLINE_HOLD_MS, type SandboxKey, sandboxKey, store } from "../store.js";
import { sandboxOrigins } from "../tools/tab-access.js";
import { untilTabLoaded } from "../tools/tab-loaded.js";

// A SITE KIT is one site's whole job done in one tool call (2026-11-12). Driving a site through the generic page tools
// takes an agent a snapshot, a click and a check per step, and on a busy app such as ChatGPT about twenty fragile calls,
// any of which can land on the wrong element or be retried into a duplicate. A kit knows the site: which elements to
// use, what "done" and "failed" look like, and how long the site takes. It is the most brittle code in this extension,
// because it depends on a page someone else redesigns at will, so each kit keeps every site-specific string and lookup
// in one table at the top of its own folder, and a layout change is a fix there.
//
// A kit gets no power the generic tools lack. Its tools pass the same gates: the browser not paused, the card's "Click
// and type" switch, the person's read-and-act grant on the site (checked before anything opens, so a site they never
// allowed is never loaded), the in-page banner, and the activity record every MCP call gets (mcp.ts). They work in the
// agent's own window, or in a new tab in front of the person when they chose to have the agent work in their tabs.

export interface Kit {
    // The site's name as a person says it ("ChatGPT").
    readonly name: string;
    // The hosts its tools work on; the person must allow each in read and act.
    readonly hosts: readonly string[];
    readonly tools: readonly McpTool<SandboxKey>[];
}

// Refuses, before anything is opened, when the agent may not act on `url`: the same decision targetTab makes for a tab
// already there (tab-access.ts), made for a page not yet loaded. Its message names what to do next (ask_access).
export const assertSiteAllowed = async (from: SandboxKey, url: string, need: "read" | "act"): Promise<void> => {
    const pattern = originPattern(url);
    const [scopes, paused, modes, origins, declined] = await Promise.all([
        store.scopes(from),
        store.paused(),
        store.modes(),
        sandboxOrigins(from),
        store.declined(),
    ]);
    const granted = pattern !== undefined && pattern in modes && (await chrome.permissions.contains({ origins: [pattern] }));
    const verdict = decide({
        url,
        granted,
        mode: pattern === undefined ? undefined : modes[pattern],
        need,
        scopes,
        paused,
        own: origins.own,
        others: origins.others,
        declined: pattern !== undefined && Date.now() - (declined[pattern] ?? -Infinity) < DECLINE_HOLD_MS,
    });
    if (!verdict.allowed) {
        throw new RefusedError(`Nothing was opened. ${verdict.message}`);
    }
};

// Runs one injected function and answers undefined, rather than throwing, when the page did not answer: the document
// was replaced mid-call (a site that reloads on a route change), or the function threw. A kit's step is followed by a
// read that says what actually happened, so a lost answer is a question to ask the page again, never a failure to
// report: page.ts's `inject` turned ChatGPT's send, which moves the tab from / to /c/<id>, into "That page did not
// answer" although the message had gone, and the agent retried it into a second send.
export const injectTolerant = async <Args extends unknown[], Result>(
    tabId: number,
    func: (...args: Args) => Result,
    args: Args,
): Promise<Awaited<Result> | undefined> => {
    try {
        const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
        const result = frame?.result;
        // SAFETY: Chrome hands back what `func` returned, serialized; null and undefined are the only other answers.
        return result === undefined || result === null ? undefined : (result as Awaited<Result>);
    } catch {
        // allow(silent-catch): a frame that went away mid-call answers nothing, which is what undefined says
        return undefined;
    }
};

// Where a kit's work happens, and what to give back when it is done.
export interface KitPlace {
    readonly tabId: number;
    // The agent's own tab that was in front of its window before the kit took the front, given back when the kit is
    // done, so the agent's next `open` lands where it was and not on the kit's page.
    readonly restore?: number | undefined;
    // The agent's window did not exist before this call, which the agent is told once.
    readonly createdWindow: boolean;
    // This call opened the tab, so a call that ends before its tab holds anything worth keeping closes it again.
    readonly createdTab: boolean;
}

// Opens `url` in a new tab for a kit: beside the agent's own tab in its window (made a window when it has none), or,
// when the person chose to have the agent work in their tabs, a new tab in front of them, so the page they were on is
// not pointed elsewhere. Waits for the page to load. Kept from being discarded: a kit's page may hold state the site
// cannot load back (a temporary chat).
export const openKitTab = async (from: SandboxKey, url: string): Promise<KitPlace> => {
    let place: KitPlace;
    if (await ownWindow()) {
        const window = await agentWindow(from);
        const front = window?.tabs?.find((tab) => tab.active === true);
        const { tab, created } = await openInAgentWindow(from, url, window !== undefined);
        if (tab?.id === undefined) {
            throw new RefusedError(`The browser did not open a tab for ${url}. Try again in a moment.`);
        }
        place = { tabId: tab.id, restore: front?.id, createdWindow: created, createdTab: true };
    } else {
        const tab = await chrome.tabs.create({ url, active: true });
        if (tab.id === undefined) {
            throw new RefusedError(`The browser did not open a tab for ${url}. Try again in a moment.`);
        }
        place = { tabId: tab.id, createdWindow: false, createdTab: true };
    }
    await untilTabLoaded(place.tabId);
    await keepLoaded(place.tabId);
    return place;
};

// Brings a kit's existing tab to the front of the agent's window for the length of a call, since a page in front of a
// covered window is throttled less than a tab behind another one (agent-window.ts). A tab outside the agent's window
// is one of the person's and is worked on where it is.
export const frontKitTab = async (from: SandboxKey, tabId: number): Promise<KitPlace> => {
    const window = (await ownWindow()) ? await agentWindow(from) : undefined;
    const front = window?.tabs?.find((tab) => tab.active === true);
    const inWindow = window?.tabs?.some((tab) => tab.id === tabId) === true;
    if (!inWindow || front?.id === tabId) {
        return { tabId, createdWindow: false, createdTab: false };
    }
    await chrome.tabs.update(tabId, { active: true });
    await keepLoaded(tabId);
    return { tabId, restore: front?.id, createdWindow: false, createdTab: false };
};

// Gives the agent's own tab the front of its window back, when the kit took it.
export const leaveKitTab = async (place: KitPlace): Promise<void> => {
    if (place.restore === undefined || place.restore === place.tabId) {
        return;
    }
    // allow(silent-catch): the agent's tab may have closed meanwhile, and then there is nothing to give back
    await chrome.tabs.update(place.restore, { active: true }).catch(() => undefined);
};

// Lets a kit's tab go: closed when it holds nothing anyone needs (a call that failed before it sent anything, or a chat
// still showing in the agent's own window that the kit no longer remembers), else left where it is but discardable again,
// since it may be one the person has since started using.
export const releaseKitTab = async (tabId: number, close: boolean): Promise<void> => {
    // allow(silent-catch): a tab already closed is released
    await (close ? chrome.tabs.remove(tabId) : chrome.tabs.update(tabId, { autoDiscardable: true }).then(() => undefined)).catch(() => undefined);
};

const keepLoaded = async (tabId: number): Promise<void> => {
    // allow(silent-catch): an older browser without autoDiscardable leaves the tab discardable, which costs only a reload
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
};

// What a kit keeps per sandbox between calls, one JSON value each, in chrome.storage: the worker holds no state
// (main.ts). `session` is for what means nothing after the browser restarts (a chat and the tab it lives in), which
// clears that area too; `local` is for what outlives a restart (the sandbox's ChatGPT project). The kit parses what it
// reads, since an earlier build may have kept another shape.
export const kitStorage = (area: "session" | "local", key: string) => {
    const storageKey = `kit:${key}`;
    const readAll = async (): Promise<Record<SandboxKey, JsonValue>> => {
        const parsed = record(string(), json()).safeParse((await chrome.storage[area].get([storageKey]))[storageKey]);
        return parsed.success ? parsed.data : {};
    };
    return {
        read: async (from: SandboxKey): Promise<JsonValue | undefined> => (await readAll())[sandboxKey(from)],
        write: async (from: SandboxKey, value: JsonValue): Promise<void> => {
            await chrome.storage[area].set({ [storageKey]: { ...(await readAll()), [sandboxKey(from)]: value } });
        },
    };
};

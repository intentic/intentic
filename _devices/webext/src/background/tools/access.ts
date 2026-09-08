import type { WebExtFacts } from "@intentic/sandbox-contract";
import { originPattern, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "./tab-access.js";

// Who this browser is, what it may touch, and how the agent asks for more. `chrome.permissions.request` only
// resolves from a user gesture, so the agent cannot grant itself a site; it can only leave a request as a badge
// and a popup line. One pending request at a time, since a queue of prompts is one nobody reads.

// The badge is the only unsolicited thing this extension shows, so it says exactly two things: something's
// waiting, or the agent is stopped.
export const refreshBadge = async (): Promise<void> => {
    const [pending, offered, paused] = await Promise.all([store.pending(), store.inbox(), store.paused()]);
    const waiting = pending !== undefined || offered !== undefined;
    await chrome.action.setBadgeText({ text: paused ? `❚❚` : waiting ? `!` : `` });
    await chrome.action.setBadgeBackgroundColor({ color: paused ? `#9c8b73` : `#e07b27` });
    await chrome.action.setTitle({
        title: paused
            ? `Intentic — paused`
            : pending !== undefined
              ? `Intentic — asking for access to ${siteOf(pending.origin)}`
              : offered !== undefined
                ? `Intentic — a sandbox is offering to connect`
                : `Intentic`,
    });
};

// A browser's own account of itself, the answer to `describe` on the socket and the substance of its card.
export const browserFacts = async (): Promise<WebExtFacts> => {
    const [tabs, grants, paused] = await Promise.all([chrome.tabs.query({}), currentGrants(), store.paused()]);
    return { browser: browserName(), tabs: tabs.length, grants, paused };
};

// "Chrome 141 on Windows", parsed from the user-agent string since `navigator.userAgentData` isn't available in
// a service worker on every supported build; only has to be recognisable, not exact.
const browserName = (): string => {
    const ua = navigator.userAgent;
    const family = /Edg\/(\d+)/.exec(ua) ?? /OPR\/(\d+)/.exec(ua) ?? /Chrome\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua);
    const name = ua.includes("Edg/") ? "Edge" : ua.includes("OPR/") ? "Opera" : ua.includes("Firefox/") ? "Firefox" : "Chrome";
    const os = /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "an unknown OS";
    return `${name} ${family?.[1] ?? "?"} on ${os}`;
};

// What the agent is told when it asks what it may touch; reads as a list of sites, not match patterns, since a
// model echoing this should echo something recognisable.
export const describeAccess = async (): Promise<string> => {
    const facts = await browserFacts();
    const lines = facts.grants.map((grant) => `  ${siteOf(grant.origin)} — ${grant.mode === "act" ? "read and act" : "read only"}`);
    return [
        `${facts.browser}, ${facts.tabs} tab${facts.tabs === 1 ? "" : "s"} open.`,
        facts.paused ? `PAUSED: its owner has stopped the agent in the extension. Every tool refuses until they resume it.` : ``,
        ``,
        facts.grants.length === 0 ? `You are not allowed on any site yet. Use ask_access to ask for one.` : `Sites you may work on:`,
        ...lines,
    ]
        .filter((line) => line !== ``)
        .join("\n");
};

// Leaves a request the person will see; says nothing about whether they'll grant it, since the answer is just a
// changed grant list on the next call.
export const askAccess = async (origin: string, reason: string): Promise<string> => {
    const pattern = originPattern(origin.includes("://") ? origin : `https://${origin}`);
    if (pattern === undefined) {
        throw new RefusedError(`"${origin}" is not a website this browser can be allowed on.`);
    }
    if (await chrome.permissions.contains({ origins: [pattern] })) {
        return `You are already allowed on ${siteOf(pattern)}.`;
    }
    await store.setPending({ origin: pattern, reason: reason.slice(0, 200), at: Date.now() });
    await refreshBadge();
    return [
        `Asked for ${siteOf(pattern)}. Their extension is now showing the request, with your reason.`,
        `Only they can grant it — the browser refuses a permission that was not asked for by a person's own click.`,
        `Tell them what you are waiting for, and stop: your next call there will either work or say no.`,
    ].join(" ");
};

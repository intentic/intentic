import type { WebExtFacts } from "@intentic/sandbox-contract";
import { originPattern, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { currentGrants } from "./tab-access.js";

/* WHO THIS BROWSER IS, WHAT IT MAY TOUCH, AND HOW THE AGENT ASKS FOR MORE.
 *
 * `askAccess` is the interesting one, and the shape of it is forced by Chrome in a way that turns out to be
 * exactly right: `chrome.permissions.request` only resolves true when it is called from a user gesture in an
 * extension page. So the agent CANNOT grant itself a site — not because this extension declines to, but
 * because the browser will not. What it can do is leave a request where the person will see it: a badge on the
 * toolbar icon and a line in the popup, with the reason it gave.
 *
 * One pending request at a time. A queue of permission prompts is a queue nobody reads, and the agent is
 * blocked on the first one anyway. */

// The badge is the only thing this extension puts in front of somebody who is not looking for it, so it says
// exactly two things: something is waiting for you, or the agent is stopped.
export const refreshBadge = async (): Promise<void> => {
    const [pending, offered, paused] = await Promise.all([store.pending(), store.inbox(), store.paused()]);
    const waiting = pending !== undefined || offered !== undefined;
    await chrome.action.setBadgeText({ text: paused ? `❚❚` : waiting ? `!` : `` });
    await chrome.action.setBadgeBackgroundColor({ color: paused ? `#8a8a94` : `#7c5cff` });
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

/* "Chrome 141 on Windows", from the user-agent string. A worse source than `navigator.userAgentData`, which is
 * not available in a service worker in every Chromium build this supports, and the string only has to be good
 * enough for a person to recognise their own browser on a card. */
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

// What the agent is told when it asks what it may touch. Reads as a list of sites rather than match patterns,
// because a model that echoes this to a person should be echoing something the person recognises.
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

// Leave a request the person will see. Deliberately says nothing about whether they will grant it: the answer
// arrives as a changed grant list, and the agent's next call either works or refuses.
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

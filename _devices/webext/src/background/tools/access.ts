import { errorMessage } from "@intentic/base/errors";
import type { WebExtFacts } from "@intentic/sandbox-contract/webext";
import { declinedMessage, originPattern, RefusedError, siteOf } from "../policy.js";
import { DECLINE_HOLD_MS, store } from "../store.js";
import { currentGrants } from "./tab-access.js";

// Who this browser is, what it may touch, and how the agent asks for more. `chrome.permissions.request` only
// resolves from a user gesture, so the agent cannot grant itself a site; it can only leave a request, which opens the
// popup and lights the badge. One pending request at a time, since a queue of prompts is one nobody reads.

// The badge says exactly two things: something's waiting for the person, or the agent is stopped. Red on white text
// for waiting, because the icon itself is ember and an ember badge disappears into it.
export const refreshBadge = async (): Promise<void> => {
    const [pending, offered, paused] = await Promise.all([store.pending(), store.inbox(), store.paused()]);
    const waiting = pending !== undefined || offered !== undefined;
    await chrome.action.setBadgeText({ text: paused ? `❚❚` : waiting ? `!` : `` });
    await chrome.action.setBadgeBackgroundColor({ color: paused ? `#6f6353` : `#d93a2b` });
    await chrome.action.setBadgeTextColor?.({ color: `#ffffff` });
    await chrome.action.setTitle({
        title: paused
            ? `Intentic — paused`
            : pending !== undefined
              ? `Intentic — your agent is asking for ${siteOf(pending.origin)}`
              : offered !== undefined
                ? `Intentic — a sandbox is offering to connect`
                : `Intentic`,
    });
};

// The shortest gap between two popups the extension opens by itself, so an agent cycling through sites can't turn a
// request into a stream of them.
const PROMPT_GAP_MS = 20_000;

// Opens the popup on the person's screen, since a request the agent is blocked on is otherwise a badge nobody looks at.
// Chrome 127 and later; before that, or with no browser window in front, the badge carries it alone. `force` is for
// a pairing the person just started with their own click in the sandbox, which the setting and the gap don't hold.
export const openPanel = async (force = false): Promise<void> => {
    const [settings, last] = await Promise.all([store.settings(), store.promptedAt()]);
    if (!force && (!settings.openOnAsk || Date.now() - last < PROMPT_GAP_MS)) {
        return;
    }
    if (chrome.action.openPopup === undefined) {
        return;
    }
    await store.setPromptedAt(Date.now());
    try {
        await chrome.action.openPopup();
    } catch (error) {
        console.warn(`intentic: could not open the popup, so the badge carries the request alone:`, errorMessage(error));
    }
};

// A browser's own account of itself, the answer to `describe` on the socket and the substance of its card.
export const browserFacts = async (): Promise<WebExtFacts> => {
    const [tabs, grants, paused, browser] = await Promise.all([chrome.tabs.query({}), currentGrants(), store.paused(), browserName()]);
    return { browser, tabs: tabs.length, grants, paused };
};

// Brave ships Chrome's user agent on purpose, so asking it is the only way to tell; any browser without the hook reads
// as what its user agent says rather than failing. The person calls this browser Brave, and everything downstream —
// their card, `describe`, the turn's own prompt — has to call it what they do.
const isBrave = async (): Promise<boolean> => {
    try {
        return (await navigator.brave?.isBrave()) === true;
    } catch {
        return false;
    }
};

// What a user agent claims to be, and the token its version follows. Chrome's token is in every Chromium UA, so it
// reads last; Brave is absent because it claims Chrome's, and `isBrave` is the only thing that knows otherwise.
const CLAIMS: readonly (readonly [token: string, name: string])[] = [
    ["Edg/", "Edge"],
    ["OPR/", "Opera"],
    ["Firefox/", "Firefox"],
    ["Chrome/", "Chrome"],
];

// ChromeOS before Linux: its user agent says both, and the more specific one is the machine a person is sitting at.
const PLATFORMS: readonly (readonly [pattern: RegExp, name: string])[] = [
    [/Windows/, "Windows"],
    [/Mac OS X/, "macOS"],
    [/CrOS/, "ChromeOS"],
    [/Linux/, "Linux"],
];

// "Brave 141 on Windows", parsed from the user-agent string since `navigator.userAgentData` isn't available in
// a service worker on every supported build; only has to be recognisable, not exact.
const browserName = async (): Promise<string> => {
    const ua = navigator.userAgent;
    const [token, claimed] = CLAIMS.find(([candidate]) => ua.includes(candidate)) ?? ["Chrome/", "Chrome"];
    const name = claimed === "Chrome" && (await isBrave()) ? "Brave" : claimed;
    const version = new RegExp(`${token}(\\d+)`).exec(ua)?.[1] ?? "?";
    const os = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1] ?? "an unknown OS";
    return `${name} ${version} on ${os}`;
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
// changed grant list on the next call. A site they declined a moment ago is refused outright, so "no" is not
// answered with the same question again.
export const askAccess = async (origin: string, reason: string): Promise<string> => {
    const pattern = originPattern(origin.includes("://") ? origin : `https://${origin}`);
    if (pattern === undefined) {
        throw new RefusedError(`"${origin}" is not a website this browser can be allowed on.`);
    }
    if (await chrome.permissions.contains({ origins: [pattern] })) {
        return `You are already allowed on ${siteOf(pattern)}.`;
    }
    const declinedAt = (await store.declined())[pattern];
    if (declinedAt !== undefined && Date.now() - declinedAt < DECLINE_HOLD_MS) {
        throw new RefusedError(declinedMessage(siteOf(pattern)));
    }
    const previous = await store.pending();
    await store.setPending({ origin: pattern, reason: reason.slice(0, 200), at: Date.now() });
    await refreshBadge();
    // Once per new request: asking again for the same site is a reminder the badge already gives.
    if (previous?.origin !== pattern) {
        await openPanel();
    }
    return [
        `Asked for ${siteOf(pattern)}. Their extension is now showing the request, with your reason.`,
        `Only they can grant it — the browser refuses a permission that was not asked for by a person's own click.`,
        `Tell them what you are waiting for, and stop: your next call there will either work or say no.`,
    ].join(" ");
};

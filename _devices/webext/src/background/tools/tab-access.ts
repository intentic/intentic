import type { WebExtGrant } from "@intentic/sandbox-contract/webext";
import { decide, originPattern, RefusedError, sandboxOwnOrigin } from "../policy.js";
import { DECLINE_HOLD_MS, store } from "../store.js";

// Single checkpoint every page tool passes through before touching a tab: which tab, is this extension allowed on
// it at all (Chrome), and may it do this here (ours). Defaults to the active tab in the current window; an
// explicit id targets one that isn't in front.

export interface TargetTab {
    readonly id: number;
    readonly url: string;
    readonly title: string;
}

// Resolves and permits a tab, or throws a RefusedError with the message the agent reads. `need` distinguishes a
// read tool from an acting one.
export const targetTab = async (need: "read" | "act", tabId?: number): Promise<TargetTab> => {
    const tab =
        tabId === undefined
            ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
            : await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.id === undefined) {
        throw new RefusedError(
            tabId === undefined ? `This browser has no active tab right now.` : `There is no tab ${tabId} in this browser any more.`,
        );
    }
    const [scopes, paused, modes, sandbox, declined] = await Promise.all([
        store.scopes(),
        store.paused(),
        store.modes(),
        store.sandbox(),
        store.declined(),
    ]);
    const pattern = originPattern(tab.url);
    // tab.url is undefined when permission is missing (Chrome's design); treat that as ungranted, not a bug.
    // Passwords may hold `<all_urls>` without listing every site in `modes`; the agent still needs an explicit allow
    // per origin, filed when the person picks Read or Read & act in the popup.
    const onAgentList = pattern !== undefined && pattern in modes;
    const granted =
        pattern !== undefined && onAgentList && (await chrome.permissions.contains({ origins: [pattern] }));
    const verdict = decide({
        url: tab.url,
        granted,
        mode: pattern === undefined ? undefined : modes[pattern],
        need,
        scopes,
        paused,
        own: sandboxOwnOrigin(sandbox?.url),
        declined: pattern !== undefined && Date.now() - (declined[pattern] ?? -Infinity) < DECLINE_HOLD_MS,
    });
    if (!verdict.allowed) {
        throw new RefusedError(verdict.message);
    }
    return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
};

// Every site the person allowed, read live from Chrome (not cached) with this extension's read/act mode beside it,
// so a permission revoked in browser settings is reflected immediately. The paired sandbox's own origin is held for
// the connection, not as a site to work on (policy.ts refuses it), so it is not listed as one: shown as a site, it
// invited a "remove" that cut the link.
// Passwords' all-sites grant (`<all_urls>`, `*://*/*`) is for capture and fill, never a site the agent was given.
const wildcard = (origin: string): boolean => origin.includes("://*") || origin === "<all_urls>";

export const currentGrants = async (): Promise<WebExtGrant[]> => {
    const [permissions, modes, sandbox] = await Promise.all([chrome.permissions.getAll(), store.modes(), store.sandbox()]);
    const own = sandboxOwnOrigin(sandbox?.url);
    return (permissions.origins ?? [])
        .filter((origin) => origin.startsWith("http") && origin !== own && origin in modes && !wildcard(origin))
        .map((origin) => ({ origin, mode: modes[origin] ?? "read" }));
};

// A site granted before every grant filed its mode was read as "read only" by the reading above until 2026-10-19, when a
// filed mode became what makes a site the agent's (so Passwords' all-sites grant could not stand in for one). Filed as
// "read" on the update, so the agent keeps exactly what the person gave it. Wildcards and the sandbox's own origin are
// skipped, so running it again after Passwords is on changes nothing.
export const fileUnmodedGrants = async (): Promise<void> => {
    const [permissions, modes, sandbox] = await Promise.all([chrome.permissions.getAll(), store.modes(), store.sandbox()]);
    const own = sandboxOwnOrigin(sandbox?.url);
    for (const origin of permissions.origins ?? []) {
        if (origin.startsWith("http") && origin !== own && !wildcard(origin) && !(origin in modes)) {
            await store.setMode(origin, "read");
        }
    }
};

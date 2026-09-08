import type { WebExtGrant } from "@intentic/sandbox-contract";
import { decide, originPattern, RefusedError, sandboxOwnOrigin } from "../policy.js";
import { store } from "../store.js";

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
    const [scopes, paused, modes, sandbox] = await Promise.all([store.scopes(), store.paused(), store.modes(), store.sandbox()]);
    const pattern = originPattern(tab.url);
    // tab.url is undefined when permission is missing (Chrome's design); treat that as ungranted, not a bug.
    const granted = pattern === undefined ? false : await chrome.permissions.contains({ origins: [pattern] });
    const verdict = decide({
        url: tab.url,
        granted,
        mode: pattern === undefined ? undefined : modes[pattern],
        need,
        scopes,
        paused,
        own: sandboxOwnOrigin(sandbox?.url),
    });
    if (!verdict.allowed) {
        throw new RefusedError(verdict.message);
    }
    return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
};

// Every site the person allowed, read live from Chrome (not cached) with this extension's read/act mode beside it,
// so a permission revoked in browser settings is reflected immediately.
export const currentGrants = async (): Promise<WebExtGrant[]> => {
    const [permissions, modes] = await Promise.all([chrome.permissions.getAll(), store.modes()]);
    return (permissions.origins ?? []).filter((origin) => origin.startsWith("http")).map((origin) => ({ origin, mode: modes[origin] ?? "read" }));
};

import type { WebExtGrant } from "@intentic/sandbox-contract";
import { decide, originPattern, RefusedError, sandboxOwnOrigin } from "../policy.js";
import { store } from "../store.js";

/* GETTING TO A TAB AT ALL — the checkpoint every page tool goes through before it touches anything.
 *
 * One function rather than a check repeated in eleven tools, because the failure mode of the repeated version
 * is the twelfth tool that forgets one of them. It answers three questions in the order they matter: which tab
 * are we talking about, may this extension be there at all (Chrome's answer), and may it do THIS there (ours).
 *
 * The default tab is the active one in the current window, which is the same default a person has in their
 * head: "the page I am looking at". An explicit id is how the agent works on a tab that is not in front. */

export interface TargetTab {
    readonly id: number;
    readonly url: string;
    readonly title: string;
}

// A tab, resolved and permitted, or a RefusedError carrying the sentence the agent reads. `need` is the
// difference between a read tool and an acting one, and it is the only thing most callers pass.
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
    /* `tab.url` is undefined for any tab this extension has no host permission for — that is Chrome's design,
     * not a bug to route around, and it is the privacy property this connector rests on: a browser connected to
     * a sandbox does not thereby disclose everything the person has open. An undefined URL is therefore
     * indistinguishable from an ungranted one, which is the correct reading of it. */
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

// Every site the person has allowed, straight from Chrome, with this extension's own read/act narrowing beside
// it. Asked rather than remembered: a permission revoked in the browser's settings is revoked, and a mirror
// would let this extension believe otherwise.
export const currentGrants = async (): Promise<WebExtGrant[]> => {
    const [permissions, modes] = await Promise.all([chrome.permissions.getAll(), store.modes()]);
    return (permissions.origins ?? []).filter((origin) => origin.startsWith("http")).map((origin) => ({ origin, mode: modes[origin] ?? "read" }));
};

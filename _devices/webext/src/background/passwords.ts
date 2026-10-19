import { errorMessage } from "@intentic/base/errors";
import { sandboxOwnOrigin } from "./policy.js";
import { store } from "./store.js";

import { nativeHostMissing, nativeRequest } from "./native.js";

// Passwords in the browser: optional all-sites access and a native host, separate from the agent's per-site grants.

const SCRIPT_ID = "intentic-passwords";
const EXCLUDE_INTENTIC = "*://*.intentic.dev/*";

export type PasswordsUiStatus =
    | { readonly kind: "off" }
    | { readonly kind: "missing-host"; readonly message: string }
    | { readonly kind: "remember-off" }
    | { readonly kind: "locked" }
    | { readonly kind: "on"; readonly version: string };

export const passwordsUiStatus = async (): Promise<PasswordsUiStatus> => {
    const enabled = await store.passwordsEnabled();
    if (!enabled) {
        return { kind: "off" };
    }
    try {
        const browser = await browserName();
        const hello = await nativeRequest({ type: "hello", browser });
        if (hello.type === "hello" && hello.ok) {
            if (!hello.remember) {
                return { kind: "remember-off" };
            }
            if (hello.locked) {
                return { kind: "locked" };
            }
            return { kind: "on", version: hello.version };
        }
        if (hello.type === "hello" && !hello.ok) {
            if (hello.code === "unavailable") {
                return { kind: "missing-host", message: "Install the Intentic desktop app, then turn on remembering from browsers in Passwords." };
            }
            if (hello.code === "locked") {
                return { kind: "locked" };
            }
            return { kind: "missing-host", message: hello.refusal };
        }
        return { kind: "missing-host", message: "Passwords on this computer did not answer." };
    } catch (error) {
        if (nativeHostMissing() || errorMessage(error).includes("Native host")) {
            return { kind: "missing-host", message: "Install the Intentic desktop app, then turn on remembering from browsers in Passwords." };
        }
        return { kind: "missing-host", message: errorMessage(error) };
    }
};

export const enablePasswordsInBrowser = async (): Promise<{ ok: boolean; message?: string }> => {
    await store.setPasswordsEnabled(true);
    try {
        await syncPasswordContentScript();
        const browser = await browserName();
        await nativeRequest({ type: "hello", browser });
        return { ok: true };
    } catch (error) {
        await store.setPasswordsEnabled(false);
        await unregisterPasswordScript();
        return { ok: false, message: errorMessage(error) };
    }
};

export const syncPasswordContentScript = async (): Promise<void> => {
    const enabled = await store.passwordsEnabled();
    if (!enabled) {
        await unregisterPasswordScript();
        return;
    }
    const hasAll = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    if (!hasAll) {
        await unregisterPasswordScript();
        return;
    }
    const sandbox = await store.sandbox();
    const excludeMatches = [EXCLUDE_INTENTIC];
    const own = sandboxOwnOrigin(sandbox?.url);
    if (own !== undefined) {
        excludeMatches.push(own);
    }
    const existing = await chrome.scripting
        .getRegisteredContentScripts({ ids: [SCRIPT_ID] })
        // allow(silent-catch): Chrome throws for an id it never registered, which is the "none yet" this asks about
        .catch(() => []);
    if (existing.some((s) => s.id === SCRIPT_ID)) {
        await chrome.scripting.updateContentScripts([
            {
                id: SCRIPT_ID,
                matches: ["<all_urls>"],
                excludeMatches,
                js: ["passwords.js"],
                runAt: "document_idle",
                persistAcrossSessions: true,
            },
        ]);
    } else {
        await chrome.scripting.registerContentScripts([
            {
                id: SCRIPT_ID,
                matches: ["<all_urls>"],
                excludeMatches,
                js: ["passwords.js"],
                runAt: "document_idle",
                persistAcrossSessions: true,
            },
        ]);
    }
};

const unregisterPasswordScript = async (): Promise<void> => {
    await chrome.scripting
        .unregisterContentScripts({ ids: [SCRIPT_ID] })
        // allow(silent-catch): unregistering one never registered throws, and nothing registered is what this wants
        .catch(() => undefined);
};

const hostFromSender = (sender: chrome.runtime.MessageSender): string | undefined => {
    const url = sender.tab?.url ?? sender.url;
    if (url === undefined) {
        return undefined;
    }
    try {
        return new URL(url).hostname;
    } catch {
        // allow(silent-catch): an address that does not parse has no site to save or fill for, which is the answer
        return undefined;
    }
};

export const handlePasswordContentMessage = async (
    message: PasswordContentMessage,
    sender: chrome.runtime.MessageSender,
): Promise<unknown> => {
    if (sender.tab?.id === undefined) {
        return { ok: false, error: "Only tabs may use Passwords." };
    }
    const host = hostFromSender(sender);
    if (host === undefined || host === "") {
        return { ok: false, error: "Not an ordinary web page." };
    }
    // The content script skips private windows itself; this holds even if it did not.
    if (message.type === "capture" && sender.tab.incognito === true) {
        return { ok: false, error: "Nothing is saved from a private window." };
    }
    const browser = await browserName();
    switch (message.type) {
        case "capture": {
            const response = await nativeRequest({
                type: "capture",
                browser,
                host,
                username: message.username,
                password: message.password,
                title: message.title,
                failed: message.failed,
            });
            return response;
        }
        case "candidates": {
            return await nativeRequest({ type: "candidates", host });
        }
        case "fill": {
            return await nativeRequest({ type: "fill", host, name: message.name });
        }
        case "undo": {
            return await nativeRequest({ type: "undo", name: message.name, at: message.at });
        }
        case "never": {
            return await nativeRequest({ type: "never", host });
        }
        default:
            return { ok: false, error: "Unknown message." };
    }
};

export type PasswordContentMessage =
    | { readonly type: "capture"; readonly username?: string; readonly password: string; readonly title?: string; readonly failed?: boolean }
    | { readonly type: "candidates" }
    | { readonly type: "fill"; readonly name: string }
    | { readonly type: "undo"; readonly name: string; readonly at: number }
    | { readonly type: "never" };

const browserName = async (): Promise<string> => {
    if (navigator.brave?.isBrave !== undefined && (await navigator.brave.isBrave())) {
        return "Brave";
    }
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) {
        return "Edge";
    }
    return "Chrome";
};

/** Called on worker wake so a registered script survives restarts. */
export const passwordsStartup = async (): Promise<void> => {
    if (await store.passwordsEnabled()) {
        await syncPasswordContentScript().catch((error: Error) => console.warn("intentic: the Passwords content script could not be registered again", error));
    }
};

export const addNeverSaveHost = async (host: string): Promise<void> => {
    const list = await store.neverSaveHosts();
    if (!list.includes(host)) {
        await store.setNeverSaveHosts([...list, host]);
    }
};

import { parseWebextPairingCode } from "@intentic/sandbox-contract";
import { closeLink, ensureLink, linkState } from "./link.js";
import type { PopupCommand, PopupState } from "./messages.js";
import { store } from "./store.js";
import { currentGrants } from "./tools/tab-access.js";
import { refreshBadge } from "./tools/access.js";

/* THE SERVICE WORKER'S ENTRY POINT: keep the socket up, and answer the popup.
 *
 * There is deliberately no state in this file. An MV3 worker is rebuilt from scratch every time Chrome decides
 * to run it, so the only durable things are storage and this handful of listeners, which Chrome re-registers by
 * re-executing this module. Anything that looked like a long-lived object here would be a bug that only shows
 * up after thirty idle seconds — the hardest kind of extension bug to find, because it never reproduces while
 * you are watching. */

// The keepalive. Chrome's floor for a periodic alarm is one minute, which is far longer than the worker's idle
// timeout — that is fine, and it is why this is a SAFETY NET rather than the mechanism: an open socket keeps
// its own worker alive through the sandbox's 20-second heartbeat, and this is what re-dials after the gap when
// it did not (a laptop that slept, a sandbox that restarted, a network that changed).
const ALARM = "intentic-link";

const wake = (): void => {
    chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    void ensureLink();
    void refreshBadge();
};

chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) {
        void ensureLink();
    }
});

// A site the person revoked in Chrome's own settings rather than in this popup. The mode we kept for it is now
// meaningless, and leaving it would mean re-granting the site later silently restored "read and act".
chrome.permissions.onRemoved.addListener((removed) => {
    for (const origin of removed.origins ?? []) {
        void store.forgetMode(origin);
    }
});

const readState = async (): Promise<PopupState> => {
    const [sandbox, scopes, grants, pending, offered, paused, log] = await Promise.all([
        store.sandbox(),
        store.scopes(),
        currentGrants(),
        store.pending(),
        store.inbox(),
        store.paused(),
        store.log(),
    ]);
    return { sandbox, link: linkState(), scopes, grants, pending, offered, paused, log };
};

/* Redeem a pairing and dial. The host permission for the sandbox's own origin was already obtained by the
 * popup — a `fetch` from an extension needs one, and only a page with a user's click behind it can ask. */
const pair = async (code: string): Promise<{ ok: boolean; message: string }> => {
    const pairing = parseWebextPairingCode(code);
    if (pairing === undefined) {
        return { ok: false, message: `That is not a connection code from a sandbox. Copy it again from the browser's capability card.` };
    }
    const response = await fetch(`${pairing.url.replace(/\/$/, "")}/system/webext/enroll`, {
        method: "POST",
        headers: { "x-intentic-pair": pairing.token },
    }).catch(() => undefined);
    if (response === undefined) {
        return { ok: false, message: `Could not reach ${pairing.url}. Is the sandbox running?` };
    }
    if (!response.ok) {
        return { ok: false, message: `That code has expired. Click Connect again in your sandbox for a fresh one.` };
    }
    const enrolled = (await response.json()) as { extensionToken?: string };
    if (typeof enrolled.extensionToken !== "string") {
        return { ok: false, message: `The sandbox answered something this extension could not read.` };
    }
    await store.setSandbox({ url: pairing.url, token: enrolled.extensionToken });
    await store.setInbox(undefined);
    await store.append({ at: Date.now(), tool: "connection", detail: `paired with ${pairing.url}`, ok: true });
    await ensureLink();
    await refreshBadge();
    return { ok: true, message: `Connected.` };
};

const handle = async (command: PopupCommand): Promise<unknown> => {
    switch (command.type) {
        case "state":
            return await readState();
        case "pair":
            return await pair(command.code);
        case "allow":
            // The browser has already granted it (the popup asked, with a click behind it); this only files the
            // read/act narrowing Chrome has no concept of, and clears the request that prompted it.
            await store.setMode(command.origin, command.mode);
            await store.setPending(undefined);
            await refreshBadge();
            return { ok: true };
        case "mode":
            await store.setMode(command.origin, command.mode);
            return { ok: true };
        case "revoke":
            await chrome.permissions.remove({ origins: [command.origin] });
            await store.forgetMode(command.origin);
            return { ok: true };
        case "pause":
            await store.setPaused(command.value);
            await store.append({
                at: Date.now(),
                tool: "connection",
                detail: command.value ? "paused by its owner" : "resumed by its owner",
                ok: true,
            });
            await refreshBadge();
            return { ok: true };
        case "unpair":
            closeLink();
            await store.forgetSandbox();
            await refreshBadge();
            return { ok: true };
        case "offer": {
            // From the sandbox's own page. Parked rather than redeemed: enrolling needs a host permission for
            // that sandbox, which needs a click, which a page cannot supply on somebody's behalf.
            const pairing = parseWebextPairingCode(command.code);
            if (pairing === undefined) {
                return { ok: false };
            }
            await store.setInbox({ url: pairing.url, token: pairing.token });
            await refreshBadge();
            return { ok: true };
        }
    }
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    void handle(message as PopupCommand)
        .then(respond)
        .catch((error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    // Chrome closes the channel when this listener returns unless it is told to wait for `respond`.
    return true;
});

// The worker was just started by something other than install or startup (a message, an alarm, the socket).
// Dialling here is what makes the very first tool call of a turn find a live connection instead of a race.
wake();

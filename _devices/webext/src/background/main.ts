import { errorMessage } from "@intentic/base/errors";
import { parseWebextPairingCode } from "@intentic/sandbox-contract";
import { closeLink, ensureLink, linkState } from "./link.js";
import type { PopupCommand, PopupState } from "./messages.js";
import { store } from "./store.js";
import { currentGrants } from "./tools/tab-access.js";
import { refreshBadge } from "./tools/access.js";

// The service worker's entry point: keeps the socket up and answers the popup. Deliberately holds no state,
// since Chrome rebuilds this module from scratch on every run; only storage and these listeners survive. A
// long-lived object here would be a bug invisible until thirty idle seconds pass.

// The keepalive: a safety net, not the mechanism. Chrome's 1-minute alarm floor is longer than the worker's idle
// timeout, but an open socket's own heartbeat traffic keeps it alive; this re-dials after a gap (sleep, sandbox
// restart, network change).
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

// A site revoked in Chrome's own settings, not this popup: the mode kept for it is now meaningless, and leaving
// it would silently restore "read and act" if re-granted.
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

// Redeems a pairing and dials; the popup already obtained the host permission, since only a click-backed page
// can ask for one.
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
    const enrolled = (await response.json()) as { token?: string };
    if (typeof enrolled.token !== "string") {
        return { ok: false, message: `The sandbox answered something this extension could not read.` };
    }
    await store.setSandbox({ url: pairing.url, token: enrolled.token });
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
            // The browser already granted this (the popup asked, click behind it); this only files the read/act
            // narrowing
            // Chrome has no concept of.
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
            // From the sandbox's own page; parked, not redeemed, since enrolling needs a host permission a page can't
            // get
            // without a click.
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
        .catch((error: unknown) => respond({ ok: false, message: errorMessage(error) }));
    // Chrome closes the channel when this listener returns unless it is told to wait for `respond`.
    return true;
});

// The worker may have just started for something other than install/startup (a message, alarm, socket); dialling
// here avoids a race with the first tool call.
wake();

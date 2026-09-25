import { errorMessage } from "@intentic/base/errors";
import { parseWebextPairingCode } from "@intentic/sandbox-contract/webext";
import { closeLink, ensureLink, linkState } from "./link.js";
import type { PopupCommand, PopupState } from "./messages.js";
import { store } from "./store.js";
import { currentGrants } from "./tools/tab-access.js";
import { openPanel, refreshBadge } from "./tools/access.js";
import { siteOf } from "./policy.js";

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

// A site allowed outside the popup (Chrome's own site-access menu): if it is the one the agent asked for, the request
// is answered, and the badge should stop saying otherwise.
chrome.permissions.onAdded.addListener((added) => {
    void (async () => {
        const pending = await store.pending();
        for (const origin of added.origins ?? []) {
            await store.forgetDecline(origin);
            if (pending?.origin === origin) {
                await store.setPending(undefined);
            }
        }
        await refreshBadge();
    })();
});

const readState = async (): Promise<PopupState> => {
    const [sandbox, scopes, grants, pending, offered, paused, log, settings] = await Promise.all([
        store.sandbox(),
        store.scopes(),
        currentGrants(),
        store.pending(),
        store.inbox(),
        store.paused(),
        store.log(),
        store.settings(),
    ]);
    return { sandbox, link: linkState(), scopes, grants, pending, offered, paused, log, settings };
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
    await store.append({ at: Date.now(), tool: "connection", detail: `Connected to ${siteOf(pairing.url)}`, ok: true });
    await ensureLink();
    await refreshBadge();
    return { ok: true, message: `Connected.` };
};

// Something the person did in the popup, in the same activity list as the agent's calls, so "why can it act on
// github.com" has its answer beside what it did there.
const owner = async (detail: string): Promise<void> => await store.append({ at: Date.now(), tool: "owner", detail, ok: true });

const handle = async (command: PopupCommand): Promise<unknown> => {
    switch (command.type) {
        case "state":
            return await readState();
        case "pair":
            return await pair(command.code);
        case "allow": {
            // The browser already granted this (the popup asked, click behind it); this only files the read/act
            // narrowing Chrome has no concept of.
            await store.setMode(command.origin, command.mode);
            await store.forgetDecline(command.origin);
            const pending = await store.pending();
            if (pending === undefined || pending.origin === command.origin) {
                await store.setPending(undefined);
            }
            await owner(`Allowed ${siteOf(command.origin)} to ${command.mode === "act" ? "read and act" : "read only"}`);
            await refreshBadge();
            return { ok: true };
        }
        case "mode":
            await store.setMode(command.origin, command.mode);
            await owner(`Set ${siteOf(command.origin)} to ${command.mode === "act" ? "read and act" : "read only"}`);
            return { ok: true };
        case "revoke":
            await chrome.permissions.remove({ origins: [command.origin] });
            await store.forgetMode(command.origin);
            await owner(`Removed ${siteOf(command.origin)}`);
            return { ok: true };
        case "decline": {
            const pending = await store.pending();
            if (pending !== undefined) {
                await store.decline(pending.origin, Date.now());
                await store.setPending(undefined);
                await owner(`Declined ${siteOf(pending.origin)}`);
            }
            await refreshBadge();
            return { ok: true };
        }
        case "settings":
            await store.setSettings(command.settings);
            return { ok: true };
        case "pause":
            await store.setPaused(command.value);
            await owner(command.value ? "Paused the agent" : "Resumed the agent");
            await refreshBadge();
            return { ok: true };
        case "unpair":
            closeLink();
            await store.forgetSandbox();
            await refreshBadge();
            return { ok: true };
        case "dismiss-offer":
            await store.setInbox(undefined);
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
            // The person just clicked Connect in their sandbox; the popup is the next step, so it comes to them.
            await openPanel(true);
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

import { errorMessage } from "@intentic/base/errors";
import { parseWebextPairingCode } from "@intentic/sandbox-contract/webext";
import { redeemPairing } from "./enroll.js";
import { closeLink, ensureLink, linkState } from "./link.js";
import type { PopupCommand, PopupState } from "./messages.js";
import { store } from "./store.js";
import { currentGrants, fileUnmodedGrants } from "./tools/tab-access.js";
import { openPanel, refreshBadge } from "./tools/access.js";
import {
    addNeverSaveHost,
    enablePasswordsInBrowser,
    handlePasswordContentMessage,
    passwordsStartup,
    passwordsUiStatus,
    syncPasswordContentScript,
    type PasswordContentMessage,
} from "./passwords.js";
import { siteOf } from "./policy.js";
import { choose, granted, owner } from "./site-grants.js";

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
    void passwordsStartup();
};

chrome.runtime.onInstalled.addListener(wake);
// An update from before a site's mode was required keeps the agent's sites (tab-access.ts `fileUnmodedGrants`).
chrome.runtime.onInstalled.addListener((details) => {
    if (details?.reason === "update") {
        void fileUnmodedGrants();
    }
});
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

// A site Chrome just granted, from its own dialog (the popup that asked is closed by then) or its own site-access menu:
// filed with the mode the person picked, or as read only when it answers the agent's request (site-grants.ts).
chrome.permissions.onAdded.addListener((added) => {
    void granted(added.origins ?? []);
});

const readState = async (): Promise<PopupState> => {
    const [sandbox, scopes, grants, pending, offered, paused, log, settings, passwords] = await Promise.all([
        store.sandbox(),
        store.scopes(),
        currentGrants(),
        store.pending(),
        store.inbox(),
        store.paused(),
        store.log(),
        store.settings(),
        passwordsUiStatus(),
    ]);
    return { sandbox, link: linkState(), scopes, grants, pending, offered, paused, log, settings, passwords };
};

// Redeems a pairing and dials; the popup already obtained the host permission, since only a click-backed page
// can ask for one.
const pair = async (code: string): Promise<{ ok: boolean; message: string }> => {
    const pairing = parseWebextPairingCode(code);
    if (pairing === undefined) {
        return { ok: false, message: `That is not a connection code from a sandbox. Copy it again from the browser's capability card.` };
    }
    const enrolled = await redeemPairing(pairing);
    switch (enrolled.kind) {
        case "enrolled":
            break;
        case "unreachable":
            return { ok: false, message: `Could not reach ${pairing.url}. Is the sandbox running?` };
        case "starting":
            return { ok: false, message: `The sandbox is still starting (HTTP ${enrolled.status}). Paste the same code again in a moment.` };
        case "expired":
            return { ok: false, message: `That code has expired. Click Connect again in your sandbox for a fresh one.` };
        case "refused":
            return { ok: false, message: `The sandbox refused the code (HTTP ${enrolled.status}). Click Connect again in your sandbox for a fresh one.` };
        case "unreadable":
            return { ok: false, message: `The sandbox answered something this extension could not read.` };
    }
    await store.setSandbox({ url: pairing.url, token: enrolled.token });
    await store.setInbox(undefined);
    await store.append({ at: Date.now(), tool: "connection", detail: `Connected to ${siteOf(pairing.url)}`, ok: true });
    await ensureLink();
    await syncPasswordContentScript().catch((error: unknown) => console.warn("intentic: the Passwords content script could not be brought in step", error));
    await refreshBadge();
    return { ok: true, message: `Connected.` };
};

const decline = async (): Promise<{ ok: true }> => {
    const pending = await store.pending();
    if (pending !== undefined) {
        await store.decline(pending.origin, Date.now());
        await store.setPending(undefined);
        await owner(`Declined ${siteOf(pending.origin)}`);
    }
    await refreshBadge();
    return { ok: true };
};

// Passwords' one popup command.
const enablePasswords = async (): Promise<{ ok: boolean; message?: string }> => {
    const enabled = await enablePasswordsInBrowser();
    if (enabled.ok) {
        await owner("Turned on remembering passwords in this browser");
    }
    return enabled;
};

const handle = async (command: PopupCommand): Promise<unknown> => {
    switch (command.type) {
        case "state":
            return await readState();
        case "pair":
            return await pair(command.code);
        case "allow":
            await choose(command.origin, command.mode);
            return { ok: true };
        case "mode":
            await store.setMode(command.origin, command.mode);
            await owner(`Set ${siteOf(command.origin)} to ${command.mode === "act" ? "read and act" : "read only"}`);
            return { ok: true };
        case "revoke":
            await chrome.permissions.remove({ origins: [command.origin] });
            await store.forgetMode(command.origin);
            await owner(`Removed ${siteOf(command.origin)}`);
            return { ok: true };
        case "decline":
            return await decline();
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
        case "passwords-enable":
            return await enablePasswords();
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

const handlePasswordChannel = async (message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> => {
    const type = message["type"];
    if (type === "never-list") {
        return await store.neverSaveHosts();
    }
    if (type === "never") {
        const host = hostFromPasswordSender(sender);
        if (host !== undefined) {
            await addNeverSaveHost(host);
        }
        return await handlePasswordContentMessage({ type: "never" }, sender);
    }
    return await handlePasswordContentMessage(message as PasswordContentMessage, sender);
};

const hostFromPasswordSender = (sender: chrome.runtime.MessageSender): string | undefined => {
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message === "object" && message !== null && (message as { channel?: string }).channel === "passwords") {
        void handlePasswordChannel(message as Record<string, unknown>, sender)
            .then(respond)
            .catch((error: unknown) => respond({ ok: false, message: errorMessage(error) }));
        return true;
    }
    // Passwords' content script runs on every site, so a command from a tab is only ever the pairing bridge's offer on
    // the sandbox's own page; every other command is the popup's, from this extension's own page.
    // SAFETY: only the `type` field is read, and anything that is not the string "offer" is refused.
    if (sender.tab !== undefined && (message as { type?: unknown }).type !== "offer") {
        respond({ ok: false, message: "That is the popup's to ask." });
        return false;
    }
    void handle(message as PopupCommand)
        .then(respond)
        .catch((error: unknown) => respond({ ok: false, message: errorMessage(error) }));
    // Chrome closes the channel when this listener returns unless it is told to wait for `respond`.
    return true;
});

// The worker may have just started for something other than install/startup (a message, alarm, socket); dialling
// here avoids a race with the first tool call.
wake();

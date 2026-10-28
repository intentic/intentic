import { errorMessage } from "@intentic/base/errors";
import { parseWebextPairingCode } from "@intentic/sandbox-contract/webext";
import { agentWindow, forgetClosedWindow, rememberBounds, showTab } from "./agent-window.js";
import { answerAsking, clearStaleAsking } from "./asking.js";
import { redeemPairing } from "./enroll.js";
import { closeLink, ensureLinks, linkState } from "./link.js";
import type { PopupCommand, PopupState, SandboxState } from "./messages.js";
import { type PairedSandbox, sandboxKey, sandboxName, store } from "./store.js";
import { currentGrants, fileUnmodedGrants } from "./tools/tab-access.js";
import { openPanel, refreshBadge } from "./tools/access.js";
import { notifySandboxGrantsChanged } from "./tools/grants-changed.js";
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
    // A build from before several sandboxes could be paired kept its one in other keys: moved first, so the first dial
    // finds it.
    void store.migrate().then(ensureLinks);
    void refreshBadge();
    void passwordsStartup();
    void clearStaleAsking();
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
        void ensureLinks();
    }
});

// A site revoked in Chrome's own settings, not this popup: the mode kept for it is now meaningless, and leaving
// it would silently restore "read and act" if re-granted.
chrome.permissions.onRemoved.addListener((removed) => {
    for (const origin of removed.origins ?? []) {
        void store.forgetMode(origin);
    }
});

// The agent's own window (agent-window.ts): wherever the person moves it is where the next one opens, and once they
// close it the next `open` makes another.
chrome.windows.onBoundsChanged.addListener((window) => void rememberBounds(window));
chrome.windows.onRemoved.addListener((windowId) => void forgetClosedWindow(windowId));

// A site Chrome just granted, from its own dialog (the popup that asked is closed by then) or its own site-access menu:
// filed with the mode the person picked, or as read only when it answers an agent's request (site-grants.ts). Once
// filed, every paired sandbox is told, so an agent waiting on `ask_access` goes on now (grants-changed.ts, 2026-10-20).
chrome.permissions.onAdded.addListener((added) => {
    void granted(added.origins ?? []).then(notifySandboxGrantsChanged);
});

// One paired sandbox as the popup shows it: never its token, which the popup has no use for.
const sandboxState = async (sandbox: PairedSandbox): Promise<SandboxState> => {
    const key = sandboxKey(sandbox.url);
    const [scopes, window] = await Promise.all([store.scopes(key), agentWindow(key)]);
    return { url: key, name: sandboxName(sandbox), link: linkState(key), scopes, agentWindowOpen: window !== undefined };
};

const readState = async (): Promise<PopupState> => {
    const [paired, grants, pending, offered, paused, log, settings, passwords, asking] = await Promise.all([
        store.sandboxes(),
        currentGrants(),
        store.pending(),
        store.inbox(),
        store.paused(),
        store.log(),
        store.settings(),
        passwordsUiStatus(),
        store.asking(),
    ]);
    const sandboxes = await Promise.all(paired.map(sandboxState));
    return {
        sandboxes,
        grants,
        pending,
        offered:
            offered === undefined
                ? undefined
                : {
                      url: sandboxKey(offered.url),
                      name: sandboxName(offered),
                      paired: sandboxes.some((sandbox) => sandbox.url === sandboxKey(offered.url)),
                  },
        paused,
        log,
        settings,
        passwords,
        asking,
    };
};

// Redeems a pairing and dials it, beside every sandbox already paired; the popup already obtained the host
// permission, since only a click-backed page can ask for one. A sandbox paired again (its card's Connect pressed once
// more) keeps its place with the fresh token, and its old socket is dropped for one that says the new one.
const pairWith = async (pairing: PairedSandbox): Promise<{ ok: boolean; message: string }> => {
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
    const key = sandboxKey(pairing.url);
    const again = (await store.sandbox(key)) !== undefined;
    await store.addSandbox({ ...pairing, token: enrolled.token });
    const parked = await store.inbox();
    if (parked !== undefined && sandboxKey(parked.url) === key) {
        await store.setInbox(undefined);
    }
    await store.append({
        at: Date.now(),
        tool: "connection",
        detail: `${again ? "Reconnected to" : "Connected to"} ${sandboxName(pairing)}`,
        ok: true,
        sandbox: key,
    });
    if (again) {
        closeLink(key);
    }
    await ensureLinks();
    await syncPasswordContentScript().catch((error: unknown) => console.warn("intentic: the Passwords content script could not be brought in step", error));
    await refreshBadge();
    return { ok: true, message: `Connected.` };
};

const pair = async (code: string): Promise<{ ok: boolean; message: string }> => {
    const pairing = parseWebextPairingCode(code);
    if (pairing === undefined) {
        return { ok: false, message: `That is not a connection code from a sandbox. Copy it again from the browser's capability card.` };
    }
    return await pairWith(pairing);
};

// The pairing a sandbox's page parked (`offer`), accepted with the person's click in the popup.
const acceptOffer = async (): Promise<{ ok: boolean; message: string }> => {
    const parked = await store.inbox();
    if (parked === undefined) {
        return { ok: false, message: `That request is gone. Click Connect again in your sandbox.` };
    }
    return await pairWith(parked);
};

// Forgets one sandbox and drops its socket; the others stay connected, and sites stay granted, since those are the
// person's decision about this browser, not about that sandbox.
const unpair = async (url: string): Promise<{ ok: true }> => {
    const key = sandboxKey(url);
    const sandbox = await store.sandbox(key);
    closeLink(key);
    await store.forgetSandbox(key);
    if (sandbox !== undefined) {
        await owner(`Disconnected ${sandboxName(sandbox)}`);
    }
    await syncPasswordContentScript().catch((error: unknown) => console.warn("intentic: the Passwords content script could not be brought in step", error));
    await refreshBadge();
    return { ok: true };
};

// The person said no to the site a sandbox's agent asked for. The no holds for the site, whichever agent asks next:
// it is their decision about this browser.
const decline = async (sandbox: string): Promise<{ ok: true }> => {
    const pending = await store.pendingFor(sandbox);
    if (pending !== undefined) {
        await store.decline(pending.origin, Date.now());
        await store.setPending(sandbox, undefined);
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

// Connecting and disconnecting sandboxes, apart from the commands about this browser itself.
type PairingCommand = Extract<PopupCommand, { readonly type: "pair" | "offer" | "accept-offer" | "dismiss-offer" | "unpair" }>;
const PAIRING_COMMANDS: ReadonlySet<PopupCommand["type"]> = new Set(["pair", "offer", "accept-offer", "dismiss-offer", "unpair"]);
const isPairing = (command: PopupCommand): command is PairingCommand => PAIRING_COMMANDS.has(command.type);

const handlePairing = async (command: PairingCommand): Promise<unknown> => {
    switch (command.type) {
        case "pair":
            return await pair(command.code);
        case "unpair":
            return await unpair(command.sandbox);
        case "accept-offer":
            return await acceptOffer();
        case "dismiss-offer":
            await store.setInbox(undefined);
            await refreshBadge();
            return { ok: true };
        case "offer": {
            // From a sandbox's own page; parked, not redeemed, since enrolling needs a host permission a page can't
            // get without a click. Parked beside any sandbox already paired: this is how a second one is added.
            const pairing = parseWebextPairingCode(command.code);
            if (pairing === undefined) {
                return { ok: false };
            }
            await store.setInbox(pairing);
            await refreshBadge();
            // The person just clicked Connect in their sandbox; the popup is the next step, so it comes to them.
            await openPanel(true);
            return { ok: true };
        }
    }
};

const handle = async (command: PopupCommand): Promise<unknown> => {
    if (isPairing(command)) {
        return await handlePairing(command);
    }
    switch (command.type) {
        case "state":
            return await readState();
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
            return await decline(command.sandbox);
        case "settings": {
            const before = await store.settings();
            await store.setSettings(command.settings);
            if (before.workIn !== command.settings.workIn) {
                await owner(
                    command.settings.workIn === "own-window" ? "Had the agent work in its own window" : "Had the agent work in the tab in front of you",
                );
            }
            return { ok: true };
        }
        case "pause":
            await store.setPaused(command.value);
            await owner(command.value ? "Paused the agent" : "Resumed the agent");
            await refreshBadge();
            return { ok: true };
        case "passwords-enable":
            return await enablePasswords();
        case "answer":
            return { ok: await answerAsking(command.id, command.allow) };
        case "show":
            return { ok: await showTab(command.tabId === undefined ? { sandbox: command.sandbox } : { tabId: command.tabId }) };
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

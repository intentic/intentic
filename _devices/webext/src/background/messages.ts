import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract/webext";
import type { PasswordsUiStatus } from "./passwords.js";
import type { ScriptsAvailability } from "./scripts/runtime.js";
import type { LinkState } from "./link.js";
import type { ActivityEntry, Asking, PendingAccess, SandboxKey, Settings } from "./store.js";

// What the popup and service worker say to each other, typed on both sides since `chrome.runtime.sendMessage` is
// an `any` pipe that silently drops a renamed button's message. Anything needing a user gesture
// (`chrome.permissions.request`) happens in the popup; everything with state happens in the worker.

// Passwords' all-sites host pattern: exactly the one static/manifest.json lists under optional_host_permissions.
// Chrome refuses to request (and never reports holding) any pattern the manifest does not declare, and `<all_urls>`
// is wider than `*://*/*` (it adds file:// and more), so asking for it rejected and the Turn on button did nothing.
export const ALL_SITES = "*://*/*";

export type PopupCommand =
    // Everything the popup renders, in one round trip: a popup that made six calls would paint in six stages.
    | { readonly type: "state" }
    // The person pressed Connect: on a pasted code, or (no code) on the pairing a sandbox's page parked. Sent before the
    // popup asks Chrome for the sandbox's origin, since Chrome's dialog closes the popup (background/connecting.ts).
    | { readonly type: "connect"; readonly code?: string }
    // Chrome said yes and the popup is still open: the worker redeems the pairing, unless the grant already did.
    | { readonly type: "connect-finish"; readonly sandbox: SandboxKey }
    // The mode the person picked for a site, sent just before the popup asks Chrome for it: filed once Chrome holds the
    // site (site-grants.ts), since Chrome's dialog closes the popup before it could say so itself.
    | { readonly type: "allow"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "mode"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "revoke"; readonly origin: string }
    // The person said no to the site `sandbox`'s agent asked for: it clears, and the agent is told so on its next call
    // there.
    | { readonly type: "decline"; readonly sandbox: SandboxKey }
    | { readonly type: "settings"; readonly settings: Settings }
    | { readonly type: "pause"; readonly value: boolean }
    // Forgets one sandbox; the others stay connected, and sites stay granted, since that's the person's decision about
    // this extension, not that sandbox.
    | { readonly type: "unpair"; readonly sandbox: SandboxKey }
    // A sandbox's own page offered a pairing (content/pair-bridge.ts); parked, not redeemed.
    | { readonly type: "offer"; readonly code: string }
    // The person turned a parked pairing down, which is also what clears the badge it lit.
    | { readonly type: "dismiss-offer" }
    | { readonly type: "passwords-enable" }
    // The person's Allow or No to the question the agent is waiting on (background/asking.ts), given in the popup.
    | { readonly type: "answer"; readonly id: string; readonly allow: boolean }
    // Brings a tab in front: `tabId` when a question is about that tab, else the front tab of `sandbox`'s agent window.
    | { readonly type: "show"; readonly tabId: number; readonly sandbox?: undefined }
    | { readonly type: "show"; readonly sandbox: SandboxKey; readonly tabId?: undefined }
    // The popup just got the optional `userScripts` permission from the person's click: the worker brings scripts in.
    | { readonly type: "scripts-enabled" }
    // The person's Install (or Update) or Decline on a script an agent asked for, and whether that sandbox may update
    // its code without asking from then on.
    | { readonly type: "script-answer"; readonly id: string; readonly accept: boolean; readonly autoUpdate: boolean }
    | { readonly type: "script-toggle"; readonly id: string; readonly on: boolean }
    | { readonly type: "script-remove"; readonly id: string }
    | { readonly type: "script-auto-update"; readonly id: string; readonly on: boolean }
    // An installed script's code, read on demand: the state the popup polls carries none.
    | { readonly type: "script-source"; readonly id: string };

// An installed script as the popup lists it.
export interface ScriptRow {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly sites: readonly string[];
    readonly connects: readonly string[];
    readonly from: string | undefined;
    // The sandbox that wrote it, by name; it may no longer be connected.
    readonly by: string;
    readonly on: boolean;
    // Why it is not running though it is on: a site no longer allowed, pause, scripts off in the browser.
    readonly stopped: string | undefined;
    readonly autoUpdate: boolean;
    readonly hash: string;
    // Error lines in its log, and the newest one.
    readonly errors: number;
    readonly lastError: string | undefined;
    readonly updatedAt: number;
}

// A script an agent wants installed or changed, with everything the person decides on.
export interface ScriptRequestView {
    readonly id: string;
    readonly sandbox: SandboxKey;
    readonly kind: "install" | "update";
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly sites: readonly string[];
    readonly connects: readonly string[];
    readonly runAt: string;
    readonly from: string | undefined;
    readonly hash: string;
    readonly source: string;
    // The code it replaces, for an update's diff.
    readonly previous: string | undefined;
    // Hosts an update adds, which the person did not allow before.
    readonly newConnects: readonly string[];
    readonly at: number;
}

export interface ScriptsState {
    readonly availability: ScriptsAvailability;
    // The browser's own name for the switch it needs (runtime.ts toggleName).
    readonly toggle: string;
    readonly rows: readonly ScriptRow[];
    readonly requests: readonly ScriptRequestView[];
}

// One paired sandbox as the popup shows it. Its token stays in the worker.
export interface SandboxState {
    readonly url: SandboxKey;
    readonly name: string;
    readonly link: LinkState;
    // The switches on this browser's card in that sandbox, which its agent works under.
    readonly scopes: WebExtScopes;
    // Whether its agent's own window is open, for that row's "Show its window".
    readonly agentWindowOpen: boolean;
}

export interface PopupState {
    // Every paired sandbox, in the order they were paired; empty before the first.
    readonly sandboxes: readonly SandboxState[];
    readonly grants: readonly WebExtGrant[];
    // The sites the agents are waiting on, at most one per sandbox.
    readonly pending: readonly PendingAccess[];
    // A pairing waiting to be accepted, offered by a sandbox page the person had open; `paired` when that sandbox is
    // already connected and this would only renew it; `failed` when pressing Connect on it did not connect, saying why.
    readonly offered:
        | { readonly url: SandboxKey; readonly name: string; readonly paired: boolean; readonly failed: string | undefined }
        | undefined;
    readonly paused: boolean;
    readonly log: readonly ActivityEntry[];
    readonly settings: Settings;
    readonly passwords: PasswordsUiStatus;
    // What the agents are asking the person right now, on pages that may be out of their sight.
    readonly asking: readonly Asking[];
    readonly scripts: ScriptsState;
}

import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract/webext";
import type { PasswordsUiStatus } from "./passwords.js";
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
    // A pasted or accepted pairing code; the popup already obtained the host permission, so this just redeems it and
    // dials.
    | { readonly type: "pair"; readonly code: string }
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
    // The person accepted the parked pairing: the worker redeems it, so its token never passes through the popup.
    | { readonly type: "accept-offer" }
    // The person turned a parked pairing down, which is also what clears the badge it lit.
    | { readonly type: "dismiss-offer" }
    | { readonly type: "passwords-enable" }
    // The person's Allow or No to the question the agent is waiting on (background/asking.ts), given in the popup.
    | { readonly type: "answer"; readonly id: string; readonly allow: boolean }
    // Brings a tab in front: `tabId` when a question is about that tab, else the front tab of `sandbox`'s agent window.
    | { readonly type: "show"; readonly tabId: number; readonly sandbox?: undefined }
    | { readonly type: "show"; readonly sandbox: SandboxKey; readonly tabId?: undefined };

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
    // already connected and this would only renew it.
    readonly offered: { readonly url: SandboxKey; readonly name: string; readonly paired: boolean } | undefined;
    readonly paused: boolean;
    readonly log: readonly ActivityEntry[];
    readonly settings: Settings;
    readonly passwords: PasswordsUiStatus;
    // What the agents are asking the person right now, on pages that may be out of their sight.
    readonly asking: readonly Asking[];
}

import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract";
import type { ActivityEntry, PairedSandbox, PendingAccess } from "./store.js";

// What the popup and service worker say to each other, typed on both sides since `chrome.runtime.sendMessage` is
// an `any` pipe that silently drops a renamed button's message. Anything needing a user gesture
// (`chrome.permissions.request`) happens in the popup; everything with state happens in the worker.

export type PopupCommand =
    // Everything the popup renders, in one round trip: a popup that made six calls would paint in six stages.
    | { readonly type: "state" }
    // A pasted or accepted pairing code; the popup already obtained the host permission, so this just redeems it and
    // dials.
    | { readonly type: "pair"; readonly code: string }
    // A site the popup has just been granted by the browser, filed with the mode the person picked.
    | { readonly type: "allow"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "mode"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "revoke"; readonly origin: string }
    | { readonly type: "pause"; readonly value: boolean }
    // Forgets the sandbox; sites stay granted, since that's the person's decision about this extension, not that
    // sandbox.
    | { readonly type: "unpair" }
    // The sandbox's own page offered a pairing (content/pair-bridge.ts); parked, not redeemed.
    | { readonly type: "offer"; readonly code: string };

export interface PopupState {
    readonly sandbox: PairedSandbox | undefined;
    readonly link: "open" | "connecting" | "closed";
    readonly scopes: WebExtScopes;
    readonly grants: readonly WebExtGrant[];
    readonly pending: PendingAccess | undefined;
    // A pairing waiting to be accepted, offered by a sandbox page the person had open.
    readonly offered: PairedSandbox | undefined;
    readonly paused: boolean;
    readonly log: readonly ActivityEntry[];
}

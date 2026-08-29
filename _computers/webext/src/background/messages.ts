import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract";
import type { ActivityEntry, PairedSandbox, PendingAccess } from "./store.js";

/* WHAT THE POPUP AND THE SERVICE WORKER SAY TO EACH OTHER.
 *
 * One file, typed on both sides, because `chrome.runtime.sendMessage` is an `any` pipe and the failure mode of
 * an `any` pipe is a popup button that silently does nothing after a rename.
 *
 * The division of labour is not arbitrary: anything that needs a USER GESTURE happens in the popup, because a
 * service worker has no gestures. That is `chrome.permissions.request` — granting a site, and granting the
 * sandbox's own origin at pairing time. Everything with state behind it happens in the worker. So the popup
 * asks the browser for permission, then tells the worker what it got. */

export type PopupCommand =
    // Everything the popup renders, in one round trip: a popup that made six calls would paint in six stages.
    | { readonly type: "state" }
    // The person pasted a code, or accepted the one their sandbox's page handed over. The popup has already
    // obtained the host permission for that sandbox's origin; this redeems the pairing and dials.
    | { readonly type: "pair"; readonly code: string }
    // A site the popup has just been granted by the browser, filed with the mode the person picked.
    | { readonly type: "allow"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "mode"; readonly origin: string; readonly mode: WebExtGrant["mode"] }
    | { readonly type: "revoke"; readonly origin: string }
    | { readonly type: "pause"; readonly value: boolean }
    // Forget the sandbox entirely. The sites stay granted: they are the person's own decision about this
    // extension, not about that sandbox, and re-pairing should not mean re-allowing everything.
    | { readonly type: "unpair" }
    // The sandbox's own page offered a pairing (content/pair-bridge.ts). Parked, not redeemed — see store.inbox.
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

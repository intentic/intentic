import { shallowRef } from "vue";

// What the extension host made of each installed extension, written by its loader (extension-host/loader.ts) and read
// by the Extensions tab and by an extension view's error boundary. Kept here, below the host, so a view the host
// mounts can read it without importing the host that mounts it.

export interface ExtensionHostStatus {
    // id is the daemon's capability-entry handle; extensionId is the manifest-derived publisher.name identity.
    readonly id: string;
    readonly extensionId: string;
    // active: running.
    // agent-only: no UI contributions; nothing to activate.
    // disabled: switched off by the owner; the toggle's target state.
    // incompatible / error: engines mismatch, or activate() threw.
    // missing / unlisted: image and bundle disagree, a manifest with no module here, or a module here the daemon
    // doesn't list (still activated, but unswitchable).
    readonly state: "active" | "agent-only" | "disabled" | "incompatible" | "missing" | "unlisted" | "error";
    readonly detail?: string | undefined;
    // Which code ran, for a report from the extension's views to name: the revision the list gave (codeRevisionOf),
    // and whether it came compiled into this app or as a bundle fetched from the daemon. Absent where nothing ran.
    readonly revision?: string | undefined;
    readonly bundle?: "compiled-in" | "daemon" | undefined;
}

// allow(module-state): the extension host's load record, retired with the activations on a switch and on a relocale (retireExtensions)
export const extensionStatuses = shallowRef<readonly ExtensionHostStatus[]>([]);

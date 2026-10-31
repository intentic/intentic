import { shallowRef } from "vue";

// What the extension host made of each installed extension, written by its loader (extension-host/loader.ts) and read
// by the Extensions tab, an extension view's error boundary, and the core surfaces that link to a listed extension's
// view (listedViews.ts). Kept here in the workbench, below the host and every feature, so any of them can read it
// without importing the host that writes it.

export interface ExtensionHostStatus {
    // id is the daemon's capability-entry handle; extensionId is the manifest-derived publisher.name identity.
    readonly id: string;
    readonly extensionId: string;
    // active: running.
    // agent-only: no UI contributions; nothing to activate.
    // disabled: switched off by the owner; the toggle's target state.
    // incompatible: an engines mismatch, or a bundle importing a name the host does not export (bundleLinks.ts).
    // error: the bundle failed to load, or activate() threw.
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

// Whether the loader's pass finished, written by it like the statuses above: until then a view that is not registered
// may simply not have activated yet, not be gone (the rail's tiles, ExtensionHost's "nothing here").
// allow(module-state): the extension host's load record, retired with the activations on a switch and on a relocale (retireExtensions)
export const extensionsLoaded = shallowRef(false);

// Whether this window runs an extension host at all, set once it boots (useExtensionHost). A window without one (a test,
// a surface mounted on its own) has no pass to wait for, so nothing in it is ever "not activated yet".
// allow(module-state): set once per page by the host's boot, like the load record above
export const extensionHostStarted = shallowRef(false);

/** Whether a viewer missing now may still register: the host has booted and its pass over the list hasn't finished. */
export const extensionsSettling = (): boolean => extensionHostStarted.value && !extensionsLoaded.value;

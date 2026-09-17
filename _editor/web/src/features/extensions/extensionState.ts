import type { StatusVariant } from "@intentic/ui";
import type { ExtensionHostStatus } from "../../extension-host/loader";
import { t } from "@intentic/ui/i18n";

// How an extension's host status reads on a row; `active` gets no badge since an on switch already says so. What
// survives is only what the reader couldn't otherwise know:
// - `agent-only`: on and working, but nothing appears in this browser; muted words, not a problem.
// - drift or failure: a real badge, and the row floats into its own pinned group.
// - `disabled`: nothing; the switch is off and the row is dimmed already.

export interface ExtensionState {
    /** Undefined when the switch and row treatment already say it. */
    readonly label?: string;
    readonly variant: StatusVariant;
    /** Coloured pill for an exception; muted words for a fact merely worth knowing. */
    readonly badge: boolean;
    /** Floats the row into the tab's pinned "Needs attention" group. */
    readonly attention: boolean;
}

const states = (): Record<ExtensionHostStatus["state"], ExtensionState> => ({
    active: { variant: `success`, badge: false, attention: false },
    "agent-only": { label: `agent-only`, variant: `neutral`, badge: false, attention: false },
    disabled: { variant: `neutral`, badge: false, attention: false },
    incompatible: { label: `incompatible`, variant: `warning`, badge: true, attention: true },
    // Drift: image and app build disagree about what exists; never render as if all were well.
    missing: { label: t(`extensions.extensionState.versionDrift`), variant: `warning`, badge: true, attention: true },
    unlisted: { label: t(`extensions.extensionState.versionDrift`), variant: `warning`, badge: true, attention: true },
    error: { label: t(`extensions.extensionState.failedToLoad`), variant: `danger`, badge: true, attention: true },
});

// No host status: installed after boot, or not booted yet; says what to do, not a state or attention case.
const unloaded = (): ExtensionState => ({ label: t(`extensions.extensionState.reloadToLoad`), variant: `neutral`, badge: false, attention: false });

export const extensionState = (status: ExtensionHostStatus | undefined): ExtensionState =>
    status === undefined ? unloaded() : states()[status.state];

// Same silence rule for the backend half: running is unremarkable, mid-restart is muted words, only a backend that
// can't serve gets colour and the pinned group. Undefined when there's nothing worth saying.
export const backendState = (backend: { state: string; detail?: string } | undefined): ExtensionState | undefined => {
    switch (backend?.state) {
        case `error`:
            return { label: t(`extensions.extensionState.backendFailed`), variant: `danger`, badge: true, attention: true };
        case `incompatible`:
            return { label: t(`extensions.extensionState.incompatible`), variant: `warning`, badge: true, attention: true };
        // Not runnable in this image; a fact about the image, not a fault of the extension.
        case `absent`:
            return { label: t(`extensions.extensionState.backendNotInImage`), variant: `warning`, badge: false, attention: false };
        case `starting`:
        case `stopped`:
            return { label: t(`extensions.extensionState.backend`, { state: backend.state }), variant: `neutral`, badge: false, attention: false };
        default:
            return undefined;
    }
};

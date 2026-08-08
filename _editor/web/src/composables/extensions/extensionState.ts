import type { StatusVariant } from "@intentic/ui";
import type { ExtensionHostStatus } from "../../extension-host/loader";

/* HOW AN EXTENSION'S HOST STATE READS ON A ROW — and, deliberately, when it doesn't read at all.
 *
 * The tab used to badge every row: sixteen extensions, sixteen pills, fourteen of them the green word "active".
 * A badge that is on almost every row states the rule, not the exception, and the eye has to read all sixteen to
 * find the one that differs. So `active` — the nominal state of a switched-on extension — gets NO chip. The
 * switch beside it already says it is on; the row being unremarkable is the message.
 *
 * What survives is only what the reader could not otherwise know:
 *   - `agent-only`  it is on and working, but nothing of it appears in this browser. Muted words, not a badge:
 *                   informative, not a problem, and an extension can be perfectly healthy this way.
 *   - drift/failure a real badge in a real colour, and the row floats to the top of the tab in its own group.
 *   - `disabled`    nothing. The switch is off and the row is dimmed; a chip repeating it is a third copy.
 */

export interface ExtensionState {
    /** Undefined when the switch and the row treatment already say it — see the note above. */
    readonly label?: string;
    readonly variant: StatusVariant;
    /** A coloured pill (an exception) rather than muted words (merely a fact worth knowing). */
    readonly badge: boolean;
    /** Floats the row into the tab's pinned "Needs attention" group. */
    readonly attention: boolean;
}

const STATES: Record<ExtensionHostStatus["state"], ExtensionState> = {
    active: { variant: `success`, badge: false, attention: false },
    "agent-only": { label: `agent-only`, variant: `neutral`, badge: false, attention: false },
    disabled: { variant: `neutral`, badge: false, attention: false },
    incompatible: { label: `incompatible`, variant: `warning`, badge: true, attention: true },
    // Both drift states: the image and this app build disagree about what exists. Not the extension's fault and
    // not fatal, but never something to render as if all were well.
    missing: { label: `version drift`, variant: `warning`, badge: true, attention: true },
    unlisted: { label: `version drift`, variant: `warning`, badge: true, attention: true },
    error: { label: `failed to load`, variant: `danger`, badge: true, attention: true },
};

// No host status = installed after the host booted, or the host hasn't booted yet. A reload picks it up, which
// is why this says what to DO rather than naming a state — and why it is not an attention case.
const UNLOADED: ExtensionState = { label: `reload to load`, variant: `neutral`, badge: false, attention: false };

export const extensionState = (status: ExtensionHostStatus | undefined): ExtensionState => (status === undefined ? UNLOADED : STATES[status.state]);

/* THE BACKEND HALF'S READING, same silence rule: a running backend is nothing (the row being unremarkable is
 * the message), a mid-restart one is muted words (expected, self-healing — the host restarts on every toggle,
 * install and workspace edit), and only a backend that CANNOT serve gets colour and the pinned group. Returns
 * undefined when there is nothing worth saying, so the UI half's state stands. */
export const backendState = (backend: { state: string; detail?: string } | undefined): ExtensionState | undefined => {
    switch (backend?.state) {
        case `error`:
            return { label: `backend failed`, variant: `danger`, badge: true, attention: true };
        case `incompatible`:
            return { label: `incompatible`, variant: `warning`, badge: true, attention: true };
        // Not runnable here (a core image without the tree) — the same wording rule the readiness check uses:
        // a fact about this image, not a fault of the extension's.
        case `absent`:
            return { label: `backend not in this image`, variant: `warning`, badge: false, attention: false };
        case `starting`:
        case `stopped`:
            return { label: `backend ${backend.state}`, variant: `neutral`, badge: false, attention: false };
        default:
            return undefined;
    }
};
